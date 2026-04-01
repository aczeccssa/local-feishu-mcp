import {
  FeishuApiError,
  type FeishuClient,
  type LegacyDocRichContentResponse,
} from './api/feishu.js';
import { deriveMarkdownFromDocxBlocks, derivePlainTextFromDocxBlocks } from './document-render.js';

export type DocumentTokenType = 'auto' | 'node' | 'docx' | 'doc';
export type DocumentReadFormat = 'plain' | 'rich';
export type DocumentSourceType = 'wiki_node' | 'docx' | 'doc';
export type DocumentContentFormat = 'plain_text' | 'markdown';

export interface ReadDocumentOptions {
  input: string;
  format?: DocumentReadFormat;
  tokenType?: DocumentTokenType;
  preferUpgraded?: boolean;
}

export interface ReadDocumentResult {
  title: string | null;
  sourceType: DocumentSourceType;
  resolvedToken: string;
  contentFormat: DocumentContentFormat;
  content: string;
  metadata: Record<string, unknown>;
}

type ResolvedInputTokenType = Exclude<DocumentTokenType, 'auto'>;

type ParsedDocumentInput = {
  originalInput: string;
  normalizedInput: string;
  token: string;
  tokenType: ResolvedInputTokenType;
  sourceUrl?: string;
};

type ResolvedDocument = {
  sourceType: DocumentSourceType;
  resolvedType: 'docx' | 'doc';
  resolvedToken: string;
  nodeToken?: string;
  sourceUrl?: string;
  title?: string;
};

export class DocumentReadError extends Error {
  readonly kind: string;
  readonly details?: Record<string, unknown>;

  constructor(kind: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DocumentReadError';
    this.kind = kind;
    this.details = details;
  }
}

const DOCX_NOT_FOUND_CODES = new Set([1770002]);
const DOCX_PERMISSION_CODES = new Set([1770032]);
const DOCX_CONTENT_TOO_LARGE_CODES = new Set([1770033]);
const WIKI_NOT_FOUND_CODES = new Set([131005]);
const WIKI_PERMISSION_CODES = new Set([131006]);
const LEGACY_NOT_FOUND_CODES = new Set([91402, 95006]);
const LEGACY_PERMISSION_CODES = new Set([91403, 95008, 95009]);
const LEGACY_WRONG_API_CODES = new Set([95053]);
const RATE_LIMIT_CODES = new Set([99991400]);

function normalizePotentialUrl(value: string): string {
  return value.trim().replace(/#+$/, '');
}

function extractTokenFromUrl(url: URL): ParsedDocumentInput | null {
  const segments = url.pathname.split('/').filter(Boolean);

  if (segments.length < 2) {
    return null;
  }

  if (segments[0] === 'wiki' && segments[1] !== 'settings') {
    return {
      originalInput: url.toString(),
      normalizedInput: url.toString(),
      token: segments[1],
      tokenType: 'node',
      sourceUrl: url.toString(),
    };
  }

  if (segments[0] === 'docx') {
    return {
      originalInput: url.toString(),
      normalizedInput: url.toString(),
      token: segments[1],
      tokenType: 'docx',
      sourceUrl: url.toString(),
    };
  }

  if (segments[0] === 'docs') {
    return {
      originalInput: url.toString(),
      normalizedInput: url.toString(),
      token: segments[1],
      tokenType: 'doc',
      sourceUrl: url.toString(),
    };
  }

  return null;
}

function inferTokenType(token: string): ResolvedInputTokenType | null {
  if (/^wik/i.test(token)) {
    return 'node';
  }

  if (/^dox/i.test(token)) {
    return 'docx';
  }

  if (/^doc/i.test(token)) {
    return 'doc';
  }

  return null;
}

export function parseDocumentInput(
  input: string,
  tokenType: DocumentTokenType = 'auto',
): ParsedDocumentInput {
  const normalizedInput = normalizePotentialUrl(input);

  if (!normalizedInput) {
    throw new DocumentReadError('invalid_input', '文档输入不能为空');
  }

  try {
    const parsedUrl = new URL(normalizedInput);
    const urlToken = extractTokenFromUrl(parsedUrl);

    if (!urlToken) {
      throw new DocumentReadError('invalid_input', '无法从提供的飞书链接中识别文档 token', {
        input: normalizedInput,
      });
    }

    if (tokenType !== 'auto' && tokenType !== urlToken.tokenType) {
      throw new DocumentReadError('invalid_input', 'URL 与指定的 tokenType 不匹配', {
        input: normalizedInput,
        tokenType,
        detectedType: urlToken.tokenType,
      });
    }

    return urlToken;
  } catch (error) {
    if (error instanceof DocumentReadError) {
      throw error;
    }

    const resolvedType = tokenType === 'auto' ? inferTokenType(normalizedInput) : tokenType;

    if (!resolvedType) {
      throw new DocumentReadError(
        'invalid_input',
        '无法自动识别文档类型，请传入知识库节点 token、docx/document_id、旧版 docToken，或提供 tokenType',
        { input: normalizedInput },
      );
    }

    return {
      originalInput: input,
      normalizedInput,
      token: normalizedInput,
      tokenType: resolvedType,
    };
  }
}

function classifyFeishuApiError(error: FeishuApiError): DocumentReadError {
  const code = typeof error.code === 'string' ? Number.parseInt(error.code, 10) : error.code;

  if (error.status === 429 || (typeof code === 'number' && RATE_LIMIT_CODES.has(code))) {
    return new DocumentReadError('rate_limited', '飞书接口触发限流，请稍后重试', {
      path: error.path,
      status: error.status,
      code: error.code,
    });
  }

  if (typeof code === 'number' && DOCX_CONTENT_TOO_LARGE_CODES.has(code)) {
    return new DocumentReadError(
      'content_too_large',
      '文档纯文本内容超过接口限制，需要回退到 blocks 读取',
      {
        path: error.path,
        status: error.status,
        code: error.code,
      },
    );
  }

  if (
    typeof code === 'number' &&
    (DOCX_NOT_FOUND_CODES.has(code) ||
      WIKI_NOT_FOUND_CODES.has(code) ||
      LEGACY_NOT_FOUND_CODES.has(code))
  ) {
    return new DocumentReadError('not_found', '未找到目标文档或知识库节点', {
      path: error.path,
      status: error.status,
      code: error.code,
    });
  }

  if (
    (typeof code === 'number' &&
      (DOCX_PERMISSION_CODES.has(code) ||
        WIKI_PERMISSION_CODES.has(code) ||
        LEGACY_PERMISSION_CODES.has(code))) ||
    error.status === 403
  ) {
    return new DocumentReadError('permission_denied', '当前调用身份缺少访问该文档的权限', {
      path: error.path,
      status: error.status,
      code: error.code,
    });
  }

  if (typeof code === 'number' && LEGACY_WRONG_API_CODES.has(code)) {
    return new DocumentReadError(
      'unsupported_type',
      '当前旧版文档接口不支持新版文档，请改用 docx 接口',
      {
        path: error.path,
        status: error.status,
        code: error.code,
      },
    );
  }

  return new DocumentReadError('upstream_error', error.message, {
    path: error.path,
    status: error.status,
    code: error.code,
  });
}

function mapUnknownError(error: unknown): Error {
  if (error instanceof DocumentReadError) {
    return error;
  }

  if (error instanceof FeishuApiError) {
    return classifyFeishuApiError(error);
  }

  if (error instanceof Error) {
    return error;
  }

  return new Error('未知错误');
}

function extractLegacyTextFragments(value: unknown, keyHint?: string): string[] {
  if (typeof value === 'string') {
    if (!value.trim()) {
      return [];
    }

    if (!keyHint || ['text', 'content', 'title', 'paragraph', 'line'].includes(keyHint)) {
      return [value];
    }

    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(item => extractLegacyTextFragments(item));
  }

  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, nestedValue]) =>
      extractLegacyTextFragments(nestedValue, key),
    );
  }

  return [];
}

function deriveMarkdownFromLegacyRichContent(
  richContent: LegacyDocRichContentResponse,
  fallbackPlainText: string,
): string {
  try {
    const parsed = JSON.parse(richContent.content);
    const fragments = extractLegacyTextFragments(parsed);

    if (fragments.length > 0) {
      return fragments
        .join('\n\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }
  } catch {
    // ignore and fall back to raw content
  }

  return fallbackPlainText.trim();
}

async function resolveDocument(
  client: FeishuClient,
  parsedInput: ParsedDocumentInput,
): Promise<ResolvedDocument> {
  if (parsedInput.tokenType === 'node') {
    const response = await client.getNode(parsedInput.token);
    const node = response.node;

    if (node.obj_type !== 'docx' && node.obj_type !== 'doc') {
      throw new DocumentReadError(
        'unsupported_type',
        `当前知识库节点挂载的资源类型为 ${node.obj_type}，第一版仅支持 docx 和 doc`,
        {
          nodeToken: node.node_token,
          objType: node.obj_type,
        },
      );
    }

    return {
      sourceType: 'wiki_node',
      resolvedType: node.obj_type as 'docx' | 'doc',
      resolvedToken: node.obj_token,
      nodeToken: node.node_token,
      sourceUrl: parsedInput.sourceUrl,
      title: node.title,
    };
  }

  return {
    sourceType: parsedInput.tokenType,
    resolvedType: parsedInput.tokenType,
    resolvedToken: parsedInput.token,
    sourceUrl: parsedInput.sourceUrl,
  };
}

async function readDocxDocument(
  client: FeishuClient,
  resolvedDocument: ResolvedDocument,
  parsedInput: ParsedDocumentInput,
  format: DocumentReadFormat,
  preferUpgraded: boolean,
): Promise<ReadDocumentResult> {
  const documentMeta = await client.getDocxDocument(resolvedDocument.resolvedToken);
  const title = documentMeta.document.title || resolvedDocument.title || null;
  const revisionId = documentMeta.document.revision_id;
  const baseMetadata: Record<string, unknown> = {
    originalInput: parsedInput.originalInput,
    tokenType: parsedInput.tokenType,
    requestedFormat: format,
    preferUpgraded,
    revisionId,
  };

  if (resolvedDocument.sourceUrl) {
    baseMetadata.sourceUrl = resolvedDocument.sourceUrl;
  }

  if (resolvedDocument.nodeToken) {
    baseMetadata.nodeToken = resolvedDocument.nodeToken;
    baseMetadata.objType = 'docx';
  }

  if (format === 'plain') {
    try {
      const response = await client.getDocxRawContent(resolvedDocument.resolvedToken);

      return {
        title,
        sourceType: resolvedDocument.sourceType,
        resolvedToken: resolvedDocument.resolvedToken,
        contentFormat: 'plain_text',
        content: response.content.trim(),
        metadata: baseMetadata,
      };
    } catch (error) {
      const mappedError = mapUnknownError(error);
      if (!(mappedError instanceof DocumentReadError) || mappedError.kind !== 'content_too_large') {
        throw mappedError;
      }

      const blocks = await client.getAllDocxBlocks(resolvedDocument.resolvedToken, revisionId);
      return {
        title,
        sourceType: resolvedDocument.sourceType,
        resolvedToken: resolvedDocument.resolvedToken,
        contentFormat: 'plain_text',
        content: derivePlainTextFromDocxBlocks(blocks),
        metadata: {
          ...baseMetadata,
          fallbackUsed: 'docx_blocks_plain_text',
          blockCount: blocks.length,
        },
      };
    }
  }

  const blocks = await client.getAllDocxBlocks(resolvedDocument.resolvedToken, revisionId);
  return {
    title,
    sourceType: resolvedDocument.sourceType,
    resolvedToken: resolvedDocument.resolvedToken,
    contentFormat: 'markdown',
    content: deriveMarkdownFromDocxBlocks(blocks),
    metadata: {
      ...baseMetadata,
      blockCount: blocks.length,
      sourcePayload: {
        items: blocks,
      },
    },
  };
}

async function readLegacyDocument(
  client: FeishuClient,
  resolvedDocument: ResolvedDocument,
  parsedInput: ParsedDocumentInput,
  format: DocumentReadFormat,
  preferUpgraded: boolean,
): Promise<ReadDocumentResult> {
  const documentMeta = await client.getLegacyDocMeta(resolvedDocument.resolvedToken);

  if (
    preferUpgraded &&
    documentMeta.is_upgraded &&
    typeof documentMeta.upgraded_token === 'string' &&
    documentMeta.upgraded_token
  ) {
    return readDocxDocument(
      client,
      {
        ...resolvedDocument,
        resolvedType: 'docx',
        resolvedToken: documentMeta.upgraded_token,
        title: documentMeta.title || resolvedDocument.title,
      },
      parsedInput,
      format,
      preferUpgraded,
    ).then(result => ({
      ...result,
      metadata: {
        ...result.metadata,
        upgradedFromDocToken: resolvedDocument.resolvedToken,
        fallbackUsed: 'legacy_doc_upgraded_token',
      },
    }));
  }

  const baseMetadata: Record<string, unknown> = {
    originalInput: parsedInput.originalInput,
    tokenType: parsedInput.tokenType,
    requestedFormat: format,
    preferUpgraded,
  };

  if (resolvedDocument.sourceUrl) {
    baseMetadata.sourceUrl = resolvedDocument.sourceUrl;
  }

  if (resolvedDocument.nodeToken) {
    baseMetadata.nodeToken = resolvedDocument.nodeToken;
    baseMetadata.objType = 'doc';
  }

  if (format === 'plain') {
    const rawContent = await client.getLegacyDocRawContent(resolvedDocument.resolvedToken);
    return {
      title: documentMeta.title || resolvedDocument.title || null,
      sourceType: resolvedDocument.sourceType,
      resolvedToken: resolvedDocument.resolvedToken,
      contentFormat: 'plain_text',
      content: rawContent.content.trim(),
      metadata: baseMetadata,
    };
  }

  const [legacyRichContent, legacyRawContent] = await Promise.all([
    client.getLegacyDocRichContent(resolvedDocument.resolvedToken),
    client.getLegacyDocRawContent(resolvedDocument.resolvedToken),
  ]);

  return {
    title: documentMeta.title || resolvedDocument.title || null,
    sourceType: resolvedDocument.sourceType,
    resolvedToken: resolvedDocument.resolvedToken,
    contentFormat: 'markdown',
    content: deriveMarkdownFromLegacyRichContent(legacyRichContent, legacyRawContent.content),
    metadata: {
      ...baseMetadata,
      revision: legacyRichContent.revision,
      sourcePayload: {
        content: legacyRichContent.content,
      },
    },
  };
}

export async function readDocumentWithFeishu(
  client: FeishuClient,
  options: ReadDocumentOptions,
): Promise<ReadDocumentResult> {
  const format = options.format || 'plain';
  const tokenType = options.tokenType || 'auto';
  const preferUpgraded = options.preferUpgraded ?? true;

  try {
    const parsedInput = parseDocumentInput(options.input, tokenType);
    const resolvedDocument = await resolveDocument(client, parsedInput);

    if (resolvedDocument.resolvedType === 'docx') {
      return await readDocxDocument(client, resolvedDocument, parsedInput, format, preferUpgraded);
    }

    return await readLegacyDocument(client, resolvedDocument, parsedInput, format, preferUpgraded);
  } catch (error) {
    throw mapUnknownError(error);
  }
}

export function formatDocumentReadResult(result: ReadDocumentResult): string {
  return JSON.stringify(result, null, 2);
}
