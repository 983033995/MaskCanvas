import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.js';

// stdout belongs exclusively to MCP JSON-RPC; all diagnostics use stderr.
try {
  await createMcpServer().connect(new StdioServerTransport());
} catch (error) {
  console.error('MaskCanvas MCP 启动失败:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
}
