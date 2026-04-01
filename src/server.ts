import express, { type NextFunction, type Request, type Response } from 'express';
import { type IncomingMessage, type ServerResponse } from 'http';
import 'dotenv/config';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { type Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { FeishuClient } from './api/feishu.js';
import {
  DocumentReadError,
  formatDocumentReadResult,
  readDocumentWithFeishu,
} from './document-reader.js';
import { Logger, sanitizeLogArgs } from './logger.js';

const DEFAULT_HTTP_HOST = '127.0.0.1';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_MAX = 120;
const SAFE_HOST_ALIASES = ['127.0.0.1', 'localhost', '::1'];

const spaceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, '空间ID只能包含字母、数字、下划线和短横线');

const folderTokenSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, '文件夹token只能包含字母、数字、下划线和短横线');

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeHostHeader(hostHeader: string | undefined): string | null {
  if (!hostHeader) {
    return null;
  }

  const trimmed = hostHeader.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('[')) {
    const closingBracketIndex = trimmed.indexOf(']');
    return closingBracketIndex === -1 ? trimmed : trimmed.slice(1, closingBracketIndex);
  }

  const [hostname] = trimmed.split(':');
  return hostname || null;
}

function buildAllowedHosts(host: string, extraAllowedHosts: string | undefined): Set<string> {
  const allowedHosts = new Set<string>(SAFE_HOST_ALIASES);
  const normalizedHost = normalizeHostHeader(host);

  if (normalizedHost && normalizedHost !== '0.0.0.0' && normalizedHost !== '::') {
    allowedHosts.add(normalizedHost);
  }

  if (extraAllowedHosts) {
    for (const entry of extraAllowedHosts.split(',')) {
      const normalizedEntry = normalizeHostHeader(entry);
      if (normalizedEntry) {
        allowedHosts.add(normalizedEntry);
      }
    }
  }

  return allowedHosts;
}

/**
 * 飞书MCP服务器
 */
export class FeishuMcpServer {
  private readonly server: McpServer;
  private readonly feishuClient: FeishuClient;
  private readonly transports = new Map<string, SSEServerTransport>();
  private readonly httpAuthToken = process.env.MCP_AUTH_TOKEN?.trim() || null;

  /**
   * 构造函数
   * @param appId 飞书应用ID
   * @param appSecret 飞书应用密钥
   */
  constructor(appId?: string, appSecret?: string) {
    this.feishuClient = new FeishuClient(appId, appSecret);

    this.server = new McpServer(
      {
        name: '飞书文档MCP服务',
        version: '1.0.0',
      },
      {
        capabilities: {
          logging: {},
          tools: {},
        },
      },
    );

    this.registerTools();
  }

  /**
   * 注册MCP工具
   */
  private registerTools() {
    const { feishuClient } = this;

    this.server.tool('list-spaces', '列出所有可用的飞书文档空间', {}, async () => {
      try {
        const response = await feishuClient.getSpaces();
        const spaces = response.items || [];

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                spaces: spaces.map(space => ({
                  id: space.space_id,
                  name: space.name,
                })),
              }),
            },
          ],
        };
      } catch (error: unknown) {
        Logger.error('获取空间列表失败:', error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `获取空间列表失败: ${error instanceof Error ? error.message : '未知错误'}`,
            },
          ],
        };
      }
    });

    this.server.tool(
      'list-documents',
      '获取指定空间或所有空间的文档列表',
      {
        spaceId: spaceIdSchema.optional().describe('空间ID，不提供则返回所有空间的文档'),
      },
      async ({ spaceId }: { spaceId?: string }) => {
        try {
          let allDocuments: Array<Record<string, string>> = [];

          if (spaceId) {
            try {
              const response = await feishuClient.getNodes(spaceId);
              allDocuments = (response.items || []).map(node => ({
                id: node.node_token,
                nodeToken: node.node_token,
                documentToken: node.obj_token,
                documentType: node.obj_type || 'Unknown',
                name: node.title || 'Untitled',
                type: node.obj_type || 'Unknown',
                spaceId,
              }));
            } catch (error: unknown) {
              if (error instanceof Error && error.message.includes('权限')) {
                return {
                  isError: true,
                  content: [{ type: 'text', text: `无权访问空间(${spaceId})的文档` }],
                };
              }
              throw error;
            }
          } else {
            const spacesResponse = await feishuClient.getSpaces();
            const spaces = spacesResponse.items || [];

            for (const space of spaces) {
              try {
                const response = await feishuClient.getNodes(space.space_id);
                const documents = (response.items || []).map(node => ({
                  id: node.node_token,
                  nodeToken: node.node_token,
                  documentToken: node.obj_token,
                  documentType: node.obj_type || 'Unknown',
                  name: node.title || 'Untitled',
                  type: node.obj_type || 'Unknown',
                  spaceId: space.space_id,
                  spaceName: space.name,
                }));
                allDocuments = [...allDocuments, ...documents];
              } catch (error: unknown) {
                if (!(error instanceof Error) || !error.message.includes('权限')) {
                  Logger.error(`获取空间(${space.space_id})的文档列表失败:`, error);
                }
              }
            }
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ documents: allDocuments }),
              },
            ],
          };
        } catch (error: unknown) {
          Logger.error('获取文档列表失败:', error);
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `获取文档列表失败: ${error instanceof Error ? error.message : '未知错误'}`,
              },
            ],
          };
        }
      },
    );

    this.server.tool(
      'read-document',
      '读取飞书文档内容，支持知识库节点、docx 文档、旧版 doc 文档，以及对应的飞书 URL',
      {
        input: z
          .string()
          .trim()
          .min(1)
          .describe('知识库节点 token、docx/document_id、旧版 docToken，或对应飞书链接'),
        format: z
          .enum(['plain', 'rich'])
          .optional()
          .describe('读取格式，plain 返回纯文本，rich 返回 Markdown'),
        tokenType: z
          .enum(['auto', 'node', 'docx', 'doc'])
          .optional()
          .describe('输入类型，默认 auto 自动识别'),
        preferUpgraded: z
          .boolean()
          .optional()
          .describe('读取旧版 doc 时，如存在升级后的 docx，则优先读取升级后的文档'),
      },
      async ({
        input,
        format = 'plain',
        tokenType = 'auto',
        preferUpgraded = true,
      }: {
        input: string;
        format?: 'plain' | 'rich';
        tokenType?: 'auto' | 'node' | 'docx' | 'doc';
        preferUpgraded?: boolean;
      }) => {
        try {
          const result = await readDocumentWithFeishu(feishuClient, {
            input,
            format,
            tokenType,
            preferUpgraded,
          });

          return {
            content: [
              {
                type: 'text',
                text: formatDocumentReadResult(result),
              },
            ],
          };
        } catch (error: unknown) {
          Logger.error('读取文档失败:', error);

          if (error instanceof DocumentReadError) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      error: error.kind,
                      message: error.message,
                      details: error.details || {},
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }

          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    error: 'upstream_error',
                    message: error instanceof Error ? error.message : '未知错误',
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
      },
    );

    this.server.tool(
      'list-drive-documents',
      '列出云文档 (Drive) 文件，支持列出根目录文件或指定文件夹中的文件',
      {
        folderToken: folderTokenSchema
          .optional()
          .describe('文件夹 token，不提供则列出根目录 Drive 文件'),
        pageSize: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .default(50)
          .describe('每页返回数量 (1-100)'),
        pageToken: z.string().optional().describe('分页游标'),
        orderBy: z
          .enum(['EditedTime', 'CreatedTime'])
          .optional()
          .default('EditedTime')
          .describe('排序字段'),
        direction: z.enum(['Asc', 'Desc']).optional().default('Desc').describe('排序方向'),
      },
      async ({
        folderToken,
        pageSize = 50,
        pageToken = '',
        orderBy = 'EditedTime',
        direction = 'Desc',
      }) => {
        try {
          const response = await feishuClient.listDriveFiles(
            folderToken,
            pageSize,
            pageToken,
            orderBy,
            direction,
          );

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  files: (response.files || []).map(f => ({
                    token: f.token,
                    name: f.name,
                    type: f.type,
                    size: f.size,
                    createdTime: f.created_time,
                    editedTime: f.edited_time,
                    owner: f.owner?.name ?? null,
                    ownerId: f.owner?.id ?? null,
                    parentTokens: f.parent_tokens ?? [],
                    url: f.url ?? null,
                  })),
                  pageToken: response.page_token ?? null,
                  hasMore: response.has_more,
                }),
              },
            ],
          };
        } catch (error) {
          Logger.error('列出 Drive 文件失败:', error);
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `列出 Drive 文件失败: ${error instanceof Error ? error.message : '未知错误'}`,
              },
            ],
          };
        }
      },
    );

    this.server.tool(
      'list-drive-files-tree',
      '以树形结构列出飞书云文档 (Drive) 文件和文件夹，支持递归展开子目录',
      {
        folderToken: folderTokenSchema
          .optional()
          .describe('文件夹 token，不提供则列出根目录的树形结构'),
        maxDepth: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .default(3)
          .describe('最大递归深度 (1-10)'),
        pageSize: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .default(50)
          .describe('每层文件夹返回的文件数量 (1-100)'),
      },
      async ({ folderToken, maxDepth = 3, pageSize = 50 }) => {
        try {
          const tree = await feishuClient.listDriveFilesRecursively(
            folderToken ?? '',
            pageSize,
            0,
            maxDepth,
          );

          return {
            content: [{ type: 'text', text: JSON.stringify({ tree }) }],
          };
        } catch (error) {
          Logger.error('列出 Drive 文件树失败:', error);
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `列出 Drive 文件树失败: ${error instanceof Error ? error.message : '未知错误'}`,
              },
            ],
          };
        }
      },
    );
  }

  /**
   * 启动标准输入输出模式
   */
  async startStdio() {
    const transport = new StdioServerTransport();
    await this.connect(transport);
    return this;
  }

  /**
   * 启动HTTP服务器
   * @param port 端口号
   * @param host 监听地址
   */
  async startHttp(port: number = 7777, host: string = DEFAULT_HTTP_HOST) {
    const app = express();
    const allowedHosts = buildAllowedHosts(host, process.env.MCP_ALLOWED_HOSTS);
    const rateLimitWindowMs = parsePositiveInteger(
      process.env.MCP_RATE_LIMIT_WINDOW_MS,
      DEFAULT_RATE_LIMIT_WINDOW_MS,
    );
    const rateLimitMax = parsePositiveInteger(
      process.env.MCP_RATE_LIMIT_MAX,
      DEFAULT_RATE_LIMIT_MAX,
    );
    const requestTimeoutMs = parsePositiveInteger(
      process.env.MCP_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    const rateLimitEntries = new Map<string, RateLimitEntry>();

    app.disable('x-powered-by');

    app.use((req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      next();
    });

    app.use((req: Request, res: Response, next: NextFunction) => {
      const normalizedHost = normalizeHostHeader(req.headers.host);
      if (!normalizedHost || !allowedHosts.has(normalizedHost)) {
        Logger.error('拒绝非法Host头请求', { host: req.headers.host, path: req.path });
        res.status(403).send('Forbidden');
        return;
      }
      next();
    });

    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.path === '/health') {
        next();
        return;
      }

      const rateLimitKey = req.ip || req.socket.remoteAddress || 'unknown';
      const now = Date.now();
      const entry = rateLimitEntries.get(rateLimitKey);

      if (!entry || now >= entry.resetAt) {
        rateLimitEntries.set(rateLimitKey, {
          count: 1,
          resetAt: now + rateLimitWindowMs,
        });
        next();
        return;
      }

      entry.count += 1;

      if (entry.count > rateLimitMax) {
        const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
        res.setHeader('Retry-After', retryAfterSeconds.toString());
        res.status(429).send('Too Many Requests');
        return;
      }

      next();
    });

    app.get('/health', (_req: Request, res: Response) => {
      res.status(200).send('OK');
    });

    app.get('/', (_req: Request, res: Response) => {
      const authStatus = this.httpAuthToken ? '已启用' : '未启用';
      res.type('html').send(`
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8" />
            <title>飞书文档MCP服务</title>
            <style>
              body { font-family: Arial, sans-serif; max-width: 860px; margin: 0 auto; padding: 24px; line-height: 1.6; }
              h1 { color: #3370ff; }
              .status { padding: 10px 14px; border-radius: 4px; display: inline-block; background-color: #e3f0e3; color: #2b702b; }
              code, pre { background-color: #f5f5f5; border-radius: 4px; }
              code { padding: 2px 6px; }
              pre { padding: 12px; overflow-x: auto; }
            </style>
          </head>
          <body>
            <h1>飞书文档MCP服务</h1>
            <p>状态: <span class="status">运行中</span></p>
            <p>监听地址: <code>${host}:${port}</code></p>
            <p>HTTP访问令牌: <code>${authStatus}</code></p>
            <h2>安全说明</h2>
            <ul>
              <li>默认仅建议本机访问</li>
              <li>如需HTTP鉴权，请在 <code>.env</code> 中设置 <code>MCP_AUTH_TOKEN</code></li>
              <li>若使用HTTP，请优先配置本地回环地址和受控客户端</li>
            </ul>
            <h2>可用能力</h2>
            <ul>
              <li>列出知识空间</li>
              <li>列出空间文档</li>
              <li>列出云文档 (Drive) 文件</li>
              <li>列出云文档 (Drive) 文件树（支持递归展开子目录）</li>
              <li>读取知识库节点、docx 和旧版 doc 文档内容</li>
            </ul>
          </body>
        </html>
      `);
    });

    app.get('/mcp', async (req: Request, res: Response) => {
      if (!this.isHttpRequestAuthorized(req)) {
        res.status(401).send('Unauthorized');
        return;
      }

      const transport = new SSEServerTransport(
        '/mcp-messages',
        res as unknown as ServerResponse<IncomingMessage>,
      );

      this.transports.set(transport.sessionId, transport);
      res.on('close', () => {
        this.transports.delete(transport.sessionId);
      });

      Logger.log('新的MCP SSE连接已建立', { sessionId: transport.sessionId });

      try {
        await this.connect(transport);
      } catch (error: unknown) {
        this.transports.delete(transport.sessionId);
        Logger.error('建立MCP SSE连接失败:', error);
        if (!res.headersSent) {
          res.status(500).send('Failed to establish MCP connection');
        }
      }
    });

    app.post('/mcp-messages', async (req: Request, res: Response) => {
      const sessionId = this.getSessionId(req);

      if (!sessionId) {
        res.status(400).send('缺少sessionId');
        return;
      }

      const transport = this.transports.get(sessionId);

      if (!transport) {
        res.status(400).send('未找到对应的SSE会话');
        return;
      }

      try {
        await transport.handlePostMessage(
          req as unknown as IncomingMessage,
          res as unknown as ServerResponse<IncomingMessage>,
        );
      } catch (error: unknown) {
        Logger.error('处理MCP消息失败:', { sessionId, error });
        if (!res.headersSent) {
          res.status(500).send('Failed to process MCP message');
        }
      }
    });

    return new Promise<this>(resolve => {
      const server = app.listen(port, host, () => {
        server.requestTimeout = requestTimeoutMs;
        server.headersTimeout = Math.min(requestTimeoutMs, 15_000);
        server.keepAliveTimeout = 5_000;

        Logger.log(`HTTP服务器已启动，监听地址: ${host}:${port}`);
        Logger.log(`SSE端点: http://${host}:${port}/mcp`);
        Logger.log(`消息端点: http://${host}:${port}/mcp-messages`);
        Logger.log(`允许的Host头: ${Array.from(allowedHosts).join(', ')}`);

        if (this.httpAuthToken) {
          Logger.log('HTTP访问令牌鉴权已启用。客户端可通过 Bearer Token 或 ?token=... 访问 /mcp。');
        } else {
          Logger.log('HTTP访问令牌鉴权未启用。建议设置 MCP_AUTH_TOKEN，或优先使用 stdio 传输。');
        }

        resolve(this);
      });
    });
  }

  /**
   * 连接到传输层
   */
  private async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);

    Logger.log = (...args: unknown[]) => {
      const sanitizedArgs = sanitizeLogArgs(args);
      this.server.server.sendLoggingMessage({
        level: 'info',
        data: sanitizedArgs,
      });
      console.log(...sanitizedArgs);
      return sanitizedArgs;
    };

    Logger.error = (...args: unknown[]) => {
      const sanitizedArgs = sanitizeLogArgs(args);
      this.server.server.sendLoggingMessage({
        level: 'error',
        data: sanitizedArgs,
      });
      console.error(...sanitizedArgs);
      return sanitizedArgs;
    };

    Logger.log('服务器已连接，可以处理请求');
  }

  private getSessionId(req: Request): string | null {
    const sessionId = req.query.sessionId;
    return typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null;
  }

  private isHttpRequestAuthorized(req: Request): boolean {
    if (!this.httpAuthToken) {
      return true;
    }

    const authorizationHeader = req.headers.authorization;
    const bearerToken = authorizationHeader?.startsWith('Bearer ')
      ? authorizationHeader.slice('Bearer '.length).trim()
      : null;
    const queryToken = typeof req.query.token === 'string' ? req.query.token.trim() : null;

    return bearerToken === this.httpAuthToken || queryToken === this.httpAuthToken;
  }
}

export { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
