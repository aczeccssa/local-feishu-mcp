#!/usr/bin/env node
import { FeishuMcpServer } from './server.js';
import { resolve } from 'path';
import { config } from 'dotenv';
import 'dotenv/config';

const DEFAULT_HTTP_PORT = 7777;
const DEFAULT_HTTP_HOST = '127.0.0.1';

// 加载.env文件
config({ path: resolve(process.cwd(), '.env') });

// 检查必要的环境变量
if (!process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET) {
  console.error('错误: 请设置环境变量 FEISHU_APP_ID 和 FEISHU_APP_SECRET');
  console.error('您可以在 .env 文件中配置这些变量，例如：');
  console.error('FEISHU_APP_ID=your_app_id');
  console.error('FEISHU_APP_SECRET=your_app_secret');
  process.exit(1);
}

export async function startServer(): Promise<void> {
  const port = Number.parseInt(process.env.PORT || `${DEFAULT_HTTP_PORT}`, 10);
  const host = process.env.HOST?.trim() || DEFAULT_HTTP_HOST;
  const transportMode = (process.env.MCP_TRANSPORT || 'http').trim().toLowerCase();

  // 创建服务器实例
  const server = new FeishuMcpServer(
    process.env.FEISHU_APP_ID as string,
    process.env.FEISHU_APP_SECRET as string,
  );

  try {
    if (transportMode === 'stdio') {
      console.log('启动飞书MCP服务器 (stdio)...');
      await server.startStdio();
      return;
    }

    console.log('启动飞书MCP服务器 (http)...');
    await server.startHttp(port, host);
  } catch (error) {
    console.error('服务器启动失败:', error);
    process.exit(1);
  }
}

// 启动服务器
startServer();
