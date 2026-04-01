import axios, { type AxiosError } from 'axios';
import 'dotenv/config';

import { Logger } from '../logger.js';

export interface SpaceResponse {
  items: Array<{ space_id: string; name: string; description?: string }>;
  page_token?: string;
  has_more: boolean;
}

export interface WikiNode {
  node_token: string;
  obj_token: string;
  obj_type: string;
  parent_node_token: string;
  space_id: string;
  title: string;
  owner_id: string;
  create_time: string;
  update_time: string;
  node_type?: string;
  origin_node_token?: string;
  origin_space_id?: string;
  has_child?: boolean;
  creator?: string;
  owner?: string;
  node_creator?: string;
}

export interface NodeResponse {
  items: WikiNode[];
  page_token?: string;
  has_more: boolean;
}

export interface WikiNodeDetailResponse {
  node: WikiNode;
}

export interface DocxDocumentMetaResponse {
  document: {
    document_id: string;
    revision_id: number;
    title: string;
    display_setting?: Record<string, unknown>;
    cover?: Record<string, unknown>;
  };
}

export interface DocxRawContentResponse {
  content: string;
}

export interface DocxBlock {
  block_id: string;
  parent_id?: string;
  children?: string[];
  block_type: number;
  [key: string]: unknown;
}

export interface DocxBlockListResponse {
  items: DocxBlock[];
  page_token?: string;
  has_more?: boolean;
}

export interface LegacyDocMetaResponse {
  title?: string;
  url?: string;
  is_upgraded?: boolean;
  upgraded_token?: string;
  edit_time?: number;
  owner?: string;
  [key: string]: unknown;
}

export interface LegacyDocRawContentResponse {
  content: string;
}

export interface LegacyDocRichContentResponse {
  content: string;
  revision?: number;
}

export class FeishuApiError extends Error {
  readonly status?: number;
  readonly code?: number | string;
  readonly path: string;
  readonly details?: unknown;

  constructor(
    message: string,
    options: {
      path: string;
      status?: number;
      code?: number | string;
      details?: unknown;
    },
  ) {
    super(message);
    this.name = 'FeishuApiError';
    this.path = options.path;
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
  }
}

function buildErrorMessage(
  path: string,
  status?: number,
  code?: number | string,
  message?: string,
): string {
  const parts = [`飞书接口请求失败: ${path}`];

  if (typeof status === 'number') {
    parts.push(`HTTP ${status}`);
  }

  if (typeof code !== 'undefined') {
    parts.push(`code=${code}`);
  }

  if (message) {
    parts.push(message);
  }

  return parts.join(' | ');
}

export interface DriveFile {
  token: string;
  name: string;
  type: string;
  size: string;
  created_time: string;
  edited_time: string;
  owner?: { id: string; name: string; tenant_key?: string };
  parent_tokens?: string[];
  url?: string;
}

export interface DriveFileListResponse {
  files: DriveFile[];
  page_token?: string;
  has_more: boolean;
}

export interface DriveFileMetaResponse {
  file: DriveFile;
}

export interface DriveFileTreeNode extends DriveFile {
  children?: DriveFileTreeNode[];
}

export class FeishuClient {
  private readonly appId: string;
  private readonly appSecret: string;
  private accessToken: string | null;
  private tokenExpireTime: number;
  private readonly baseUrl: string;

  constructor(appId?: string, appSecret?: string) {
    this.appId = appId || process.env.FEISHU_APP_ID || '';
    this.appSecret = appSecret || process.env.FEISHU_APP_SECRET || '';
    this.accessToken = null;
    this.tokenExpireTime = 0;
    this.baseUrl = 'https://open.feishu.cn/open-apis';

    if (!this.appId || !this.appSecret) {
      Logger.error(
        '错误: 未配置飞书应用凭证。请在.env文件中设置FEISHU_APP_ID和FEISHU_APP_SECRET。',
      );
    }
  }

  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpireTime) {
      return this.accessToken;
    }

    try {
      const response = await axios.post(`${this.baseUrl}/auth/v3/tenant_access_token/internal`, {
        app_id: this.appId,
        app_secret: this.appSecret,
      });

      if (response.data.code === 0) {
        const token = response.data.tenant_access_token as string;
        this.accessToken = token;
        this.tokenExpireTime = Date.now() + response.data.expire * 1000 - 5 * 60 * 1000;
        return token;
      }

      throw new FeishuApiError(
        buildErrorMessage(
          '/auth/v3/tenant_access_token/internal',
          response.status,
          response.data?.code,
          response.data?.msg,
        ),
        {
          path: '/auth/v3/tenant_access_token/internal',
          status: response.status,
          code: response.data?.code,
          details: response.data,
        },
      );
    } catch (error) {
      Logger.error('获取飞书Token出错:', error);
      throw error;
    }
  }

  async request<T>(
    method: string,
    url: string,
    data: unknown = null,
    params: Record<string, unknown> | null = null,
  ): Promise<T> {
    try {
      const token = await this.getAccessToken();

      const response = await axios({
        method,
        url: `${this.baseUrl}${url}`,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        data,
        params,
      });

      Logger.log(`飞书API请求成功: ${method} ${url}`, { status: response.status });

      if (response.data?.code === 0) {
        return response.data.data as T;
      }

      throw new FeishuApiError(
        buildErrorMessage(url, response.status, response.data?.code, response.data?.msg),
        {
          path: url,
          status: response.status,
          code: response.data?.code,
          details: response.data,
        },
      );
    } catch (error) {
      if (error instanceof FeishuApiError) {
        Logger.error(`请求 ${url} 失败:`, {
          status: error.status,
          responseCode: error.code,
          message: error.message,
        });
        throw error;
      }

      if (axios.isAxiosError(error)) {
        throw this.handleAxiosError(url, error);
      }

      Logger.error(`请求 ${url} 失败:`, error);
      throw error;
    }
  }

  private handleAxiosError(url: string, error: AxiosError): FeishuApiError {
    const status = error.response?.status;
    const responseData = error.response?.data as
      | { code?: number | string; msg?: string }
      | undefined;

    Logger.error(`请求 ${url} 失败:`, {
      status,
      statusText: error.response?.statusText,
      responseCode: responseData?.code,
      responseMessage: responseData?.msg,
    });

    return new FeishuApiError(
      buildErrorMessage(url, status, responseData?.code, responseData?.msg || error.message),
      {
        path: url,
        status,
        code: responseData?.code,
        details: error.response?.data,
      },
    );
  }

  async getSpaces(pageSize = 50, pageToken = ''): Promise<SpaceResponse> {
    try {
      const params: Record<string, unknown> = { page_size: pageSize };
      if (pageToken) {
        params.page_token = pageToken;
      }

      return this.request<SpaceResponse>('GET', '/wiki/v2/spaces', null, params);
    } catch (error) {
      Logger.error('获取知识空间列表失败:', error);
      if (error instanceof Error && error.message.includes('Access denied')) {
        throw new Error('API权限不足: 需要wiki:wiki或wiki:wiki:readonly权限');
      }
      return { items: [], has_more: false };
    }
  }

  async getNodes(
    spaceId: string,
    parentNodeToken = '',
    pageSize = 50,
    pageToken = '',
  ): Promise<NodeResponse> {
    try {
      const params: Record<string, unknown> = { page_size: pageSize };

      if (parentNodeToken) {
        params.parent_node_token = parentNodeToken;
      }

      if (pageToken) {
        params.page_token = pageToken;
      }

      return this.request<NodeResponse>(
        'GET',
        `/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes`,
        null,
        params,
      );
    } catch (error) {
      Logger.error('获取节点列表失败:', { spaceId, error });
      if (error instanceof Error && error.message.includes('Access denied')) {
        throw new Error('API权限不足: 需要wiki:wiki或wiki:wiki:readonly权限');
      }
      return { items: [], has_more: false };
    }
  }

  async getNode(token: string, objType?: string): Promise<WikiNodeDetailResponse> {
    const params: Record<string, unknown> = { token };
    if (objType) {
      params.obj_type = objType;
    }

    return this.request<WikiNodeDetailResponse>('GET', '/wiki/v2/spaces/get_node', null, params);
  }

  async getDocxDocument(documentId: string): Promise<DocxDocumentMetaResponse> {
    return this.request<DocxDocumentMetaResponse>(
      'GET',
      `/docx/v1/documents/${encodeURIComponent(documentId)}`,
    );
  }

  async getDocxRawContent(documentId: string): Promise<DocxRawContentResponse> {
    return this.request<DocxRawContentResponse>(
      'GET',
      `/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`,
    );
  }

  async getDocxBlocks(
    documentId: string,
    pageSize = 500,
    pageToken = '',
    documentRevisionId = -1,
  ): Promise<DocxBlockListResponse> {
    const params: Record<string, unknown> = {
      page_size: pageSize,
      document_revision_id: documentRevisionId,
    };

    if (pageToken) {
      params.page_token = pageToken;
    }

    return this.request<DocxBlockListResponse>(
      'GET',
      `/docx/v1/documents/${encodeURIComponent(documentId)}/blocks`,
      null,
      params,
    );
  }

  async getAllDocxBlocks(documentId: string, documentRevisionId = -1): Promise<DocxBlock[]> {
    const blocks: DocxBlock[] = [];
    let pageToken = '';

    do {
      const response = await this.getDocxBlocks(documentId, 500, pageToken, documentRevisionId);
      blocks.push(...(response.items || []));
      pageToken = response.has_more ? response.page_token || '' : '';
    } while (pageToken);

    return blocks;
  }

  async getLegacyDocMeta(docToken: string): Promise<LegacyDocMetaResponse> {
    return this.request<LegacyDocMetaResponse>(
      'GET',
      `/doc/v2/meta/${encodeURIComponent(docToken)}`,
    );
  }

  async getLegacyDocRawContent(docToken: string): Promise<LegacyDocRawContentResponse> {
    return this.request<LegacyDocRawContentResponse>(
      'GET',
      `/doc/v2/${encodeURIComponent(docToken)}/raw_content`,
    );
  }

  async getLegacyDocRichContent(docToken: string): Promise<LegacyDocRichContentResponse> {
    return this.request<LegacyDocRichContentResponse>(
      'GET',
      `/doc/v2/${encodeURIComponent(docToken)}/content`,
    );
  }

  async listDriveFiles(
    folderToken?: string,
    pageSize = 50,
    pageToken?: string,
    orderBy: 'EditedTime' | 'CreatedTime' = 'EditedTime',
    direction: 'Asc' | 'Desc' | 'ASC' | 'DESC' = 'Desc',
  ): Promise<DriveFileListResponse> {
    const params: Record<string, unknown> = {
      page_size: pageSize,
      order_by: orderBy,
      direction: direction.toUpperCase() as 'ASC' | 'DESC',
    };
    // 只在有 folderToken 时才传递，飞书 API 不传时默认查根目录
    if (folderToken !== undefined) {
      params.folder_token = folderToken;
    }
    if (pageToken) {
      params.page_token = pageToken;
    }

    return this.request<DriveFileListResponse>('GET', '/drive/v1/files', null, params);
  }

  async listDriveFilesRecursively(
    folderToken: string,
    pageSize = 50,
    depth = 0,
    maxDepth = 3,
  ): Promise<DriveFileTreeNode[]> {
    if (depth >= maxDepth) return [];

    const files: DriveFileTreeNode[] = [];
    let pageToken = '';
    let hasMore = true;

    while (hasMore) {
      const response = await this.listDriveFiles(
        folderToken,
        pageSize,
        pageToken,
        'EditedTime',
        'ASC',
      );

      for (const file of response.files || []) {
        const node: DriveFileTreeNode = {
          token: file.token,
          name: file.name,
          type: file.type,
          size: file.size,
          created_time: file.created_time,
          edited_time: file.edited_time,
          owner: file.owner,
          parent_tokens: file.parent_tokens,
          url: file.url,
        };

        // 文件夹类型递归获取子内容
        if (file.type === 'folder' || file.type === 'docs_folder') {
          node.children = await this.listDriveFilesRecursively(
            file.token,
            pageSize,
            depth + 1,
            maxDepth,
          );
        }

        files.push(node);
      }

      hasMore = response.has_more ?? false;
      pageToken = response.page_token ?? '';
    }

    return files;
  }

  async getDriveFileMeta(fileToken: string): Promise<DriveFileMetaResponse> {
    return this.request<DriveFileMetaResponse>(
      'GET',
      `/drive/v1/files/${encodeURIComponent(fileToken)}/meta`,
    );
  }
}
