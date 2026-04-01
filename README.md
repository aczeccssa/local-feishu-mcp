# Local Feishu MCP

Local Feishu MCP is a Model Context Protocol (MCP) server for Feishu/Lark Docs and Wiki.

It lets MCP-compatible AI clients connect to your Feishu tenant and use Feishu document tools directly from coding assistants and desktop AI apps.

## What This Project Can Do

This server currently exposes the following capabilities:

- `list-spaces`
  - List all Feishu wiki/document spaces that the configured app can access.
- `list-documents`
  - List documents in a specific space.
  - List documents across all accessible spaces.
  - Return both the wiki `nodeToken` and the resolved document token when available.
- `read-document`
  - Read Feishu Wiki nodes.
  - Read Feishu `docx` documents.
  - Read legacy Feishu `doc` documents.
  - Accept either a token or a Feishu URL.
  - Support `plain` output for raw text.
  - Support `rich` output for LLM-friendly Markdown.
  - Automatically resolve `wiki node_token -> obj_token`.
  - Prefer upgraded `docx` content when reading legacy `doc` content if configured.
  - Fall back from `docx raw_content` to block-based reading when the raw content API is too large.

## What This Project Does Not Do

The current version does not support:

- Writing or updating documents
- Deleting documents
- Searching document content
- Reading Sheets, Bitable, Slides, files, or MindNotes
- Local indexing or database-backed synchronization

## Transport Modes

The server supports two MCP transport modes:

- `stdio`
  - Best option for local MCP clients such as Cursor, Claude Desktop, Cline, and Roo Code
- `http`
  - Exposes an HTTP/SSE MCP endpoint
  - Useful for tools that connect to MCP over URL

Default behavior:

- Default transport: `http`
- Default host: `127.0.0.1`
- Default port: `7777`

## Security Model

The current implementation includes these protections:

- HTTP mode binds to `127.0.0.1` by default
- Optional `MCP_AUTH_TOKEN` authentication for HTTP/SSE mode
- Host header validation
- Basic rate limiting
- Request timeout protection
- Sanitized logging to avoid leaking access tokens and secrets

Recommended practice:

- Prefer `stdio` whenever your client supports it
- If you use HTTP mode, set a strong `MCP_AUTH_TOKEN`
- Do not expose the service on `0.0.0.0` unless you have an explicit reverse-proxy and authentication design
- Never commit `.env`

## Requirements

- Node.js 20+
- `pnpm` recommended for local development
- A Feishu self-built app with the correct API scopes
- Access authorization to the target Feishu spaces or documents

## Feishu App Setup

Create a self-built app in the Feishu Open Platform and collect:

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`

Minimum scopes for current features:

- Wiki space and node listing
  - `wiki:node:read` or equivalent read-only wiki scope available in your app configuration
- `docx` reading
  - `docx:document:readonly`
- Legacy `doc` reading
  - `docs:document.content:read` or equivalent legacy docs read scope

Important:

- API scopes alone are not enough
- The app must also be granted access to the actual Feishu resources you want to read
- A wiki URL token is usually a `node_token`, not the actual `docx` document token
- This server resolves the wiki node to the real object token internally

## Local Setup

Clone the repository and install dependencies:

```bash
git clone <your-repo-url>
cd local-feishu-mcp
pnpm install
```

Create the environment file:

```bash
cp .env.example .env
```

Example `.env`:

```dotenv
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxxxxx

# Transport: stdio or http
MCP_TRANSPORT=stdio

# HTTP mode only
HOST=127.0.0.1
PORT=7777

# Strongly recommended for HTTP mode
MCP_AUTH_TOKEN=replace_with_a_long_random_token

# Optional extra allowed hosts for HTTP mode
# MCP_ALLOWED_HOSTS=localhost,127.0.0.1,[::1]
```

## Start the Server

### Option 1: Run from local source

HTTP mode:

```bash
pnpm start
```

stdio mode:

```bash
MCP_TRANSPORT=stdio pnpm start
```

### Option 2: Run through `npx` from a local checkout

This is the most useful pattern for MCP client configuration when you want to launch directly from source without installing globally.

```bash
MCP_TRANSPORT=stdio npx -y tsx /ABSOLUTE/PATH/TO/local-feishu-mcp/src/index.ts
```

### Option 3: Run through `npx` as an npm package

Use this only if `feishu-mcp` has been published to your npm registry or private registry.

```bash
MCP_TRANSPORT=stdio npx -y feishu-mcp
```

## MCP Client Configuration

Below are practical configuration patterns for common MCP-enabled development tools.

Use `stdio` unless your client specifically requires URL-based MCP.

### Generic stdio MCP configuration

Use this structure for any client that accepts `command`, `args`, and `env`:

```json
{
  "command": "npx",
  "args": ["-y", "tsx", "/ABSOLUTE/PATH/TO/local-feishu-mcp/src/index.ts"],
  "env": {
    "FEISHU_APP_ID": "cli_xxx",
    "FEISHU_APP_SECRET": "xxxxxx",
    "MCP_TRANSPORT": "stdio"
  }
}
```

If you publish the package to npm, you can switch to:

```json
{
  "command": "npx",
  "args": ["-y", "feishu-mcp"],
  "env": {
    "FEISHU_APP_ID": "cli_xxx",
    "FEISHU_APP_SECRET": "xxxxxx",
    "MCP_TRANSPORT": "stdio"
  }
}
```

### Cursor

Cursor supports MCP server definitions through its MCP settings UI or configuration file, depending on your version.

Use a stdio server definition like this:

```json
{
  "mcpServers": {
    "feishu": {
      "command": "npx",
      "args": ["-y", "tsx", "/ABSOLUTE/PATH/TO/local-feishu-mcp/src/index.ts"],
      "env": {
        "FEISHU_APP_ID": "cli_xxx",
        "FEISHU_APP_SECRET": "xxxxxx",
        "MCP_TRANSPORT": "stdio"
      }
    }
  }
}
```

Typical flow in Cursor:

1. Open Cursor settings.
2. Open MCP configuration.
3. Add a new server named `feishu`.
4. Paste the configuration above.
5. Save and reload Cursor if needed.
6. Ask Cursor to call one of the Feishu tools.

### Claude Desktop

For Claude Desktop, add the MCP server to the app MCP configuration.

Example:

```json
{
  "mcpServers": {
    "feishu": {
      "command": "npx",
      "args": ["-y", "tsx", "/ABSOLUTE/PATH/TO/local-feishu-mcp/src/index.ts"],
      "env": {
        "FEISHU_APP_ID": "cli_xxx",
        "FEISHU_APP_SECRET": "xxxxxx",
        "MCP_TRANSPORT": "stdio"
      }
    }
  }
}
```

Typical flow:

1. Open the Claude Desktop MCP config file.
2. Add the `feishu` server entry.
3. Restart Claude Desktop.
4. Confirm the server is connected.
5. Ask Claude to list spaces or read a document.

### Cline

Cline generally uses MCP stdio server definitions in the same `command + args + env` style.

Example:

```json
{
  "mcpServers": {
    "feishu": {
      "command": "npx",
      "args": ["-y", "tsx", "/ABSOLUTE/PATH/TO/local-feishu-mcp/src/index.ts"],
      "env": {
        "FEISHU_APP_ID": "cli_xxx",
        "FEISHU_APP_SECRET": "xxxxxx",
        "MCP_TRANSPORT": "stdio"
      }
    }
  }
}
```

### Roo Code

Roo Code can use the same stdio MCP launch pattern.

Example:

```json
{
  "mcpServers": {
    "feishu": {
      "command": "npx",
      "args": ["-y", "tsx", "/ABSOLUTE/PATH/TO/local-feishu-mcp/src/index.ts"],
      "env": {
        "FEISHU_APP_ID": "cli_xxx",
        "FEISHU_APP_SECRET": "xxxxxx",
        "MCP_TRANSPORT": "stdio"
      }
    }
  }
}
```

### HTTP/SSE MCP clients

If your MCP client connects over URL instead of spawning a local process, run the server in HTTP mode:

```bash
MCP_TRANSPORT=http pnpm start
```

Endpoints:

- Health check: `http://127.0.0.1:7777/health`
- MCP SSE endpoint: `http://127.0.0.1:7777/mcp`
- MCP message endpoint: `http://127.0.0.1:7777/mcp-messages`

If `MCP_AUTH_TOKEN` is set, connect with:

```text
http://127.0.0.1:7777/mcp?token=YOUR_TOKEN
```

## Tool Reference

### `list-spaces`

Purpose:

- List all accessible Feishu spaces

Input:

- No arguments

Example request:

```text
List all Feishu spaces available to this app.
```

Example result shape:

```json
{
  "spaces": [
    {
      "id": "7342174929384005634",
      "name": "Engineering Wiki"
    }
  ]
}
```

### `list-documents`

Purpose:

- List documents in one space or all spaces

Input:

- `spaceId` optional

Example request:

```text
List all documents in space 7342174929384005634.
```

Example result shape:

```json
{
  "documents": [
    {
      "id": "wikcnxxxxxxxxxxxxxxxx",
      "nodeToken": "wikcnxxxxxxxxxxxxxxxx",
      "documentToken": "doxcnxxxxxxxxxxxxxxx",
      "documentType": "docx",
      "name": "Architecture Overview",
      "type": "docx",
      "spaceId": "7342174929384005634",
      "spaceName": "Engineering Wiki"
    }
  ]
}
```

### `read-document`

Purpose:

- Read a Feishu Wiki node, `docx`, or legacy `doc`

Input:

- `input`
  - A wiki token, `docx` token, legacy `doc` token, or a Feishu URL
- `format`
  - `plain` or `rich`
  - Default: `plain`
- `tokenType`
  - `auto`, `node`, `docx`, or `doc`
  - Default: `auto`
- `preferUpgraded`
  - `true` or `false`
  - Default: `true`

Examples:

Read from a wiki URL:

```json
{
  "input": "https://sample.feishu.cn/wiki/AbCdEfGhIjKlMnOpQrStUvwx",
  "format": "plain"
}
```

Read a `docx` document as Markdown:

```json
{
  "input": "doxcnePuYufKa49ISjhD8Iabcef",
  "tokenType": "docx",
  "format": "rich"
}
```

Read a legacy `doc` and prefer the upgraded `docx` if one exists:

```json
{
  "input": "doccnilYPZU5b34ow4ca7aNoU6a",
  "tokenType": "doc",
  "format": "plain",
  "preferUpgraded": true
}
```

Example result shape:

```json
{
  "title": "Architecture Overview",
  "sourceType": "docx",
  "resolvedToken": "doxcnxxxxxxxxxxxxxxx",
  "contentFormat": "markdown",
  "content": "# Architecture Overview\n\nSystem design notes...",
  "metadata": {
    "inputType": "node",
    "requestedFormat": "rich"
  }
}
```

## End-to-End Usage Examples

### Example 1: List spaces

Ask your MCP client:

```text
List all Feishu spaces I can access.
```

### Example 2: List documents in a space

```text
List all documents in space 7342174929384005634.
```

### Example 3: Read a wiki page

```text
Read this Feishu wiki page and summarize it:
https://sample.feishu.cn/wiki/AbCdEfGhIjKlMnOpQrStUvwx
```

### Example 4: Read a document as Markdown for LLM processing

```text
Read this document in rich mode and return Markdown:
{
  "input": "doxcnePuYufKa49ISjhD8Iabcef",
  "format": "rich"
}
```

### Example 5: Use the server for code or document workflows

Practical prompts:

- `List all Feishu spaces available to this app.`
- `List documents in the Engineering Wiki space.`
- `Read this Feishu page and extract the action items.`
- `Read this architecture document as Markdown and generate a technical summary.`
- `Compare two Feishu documents and identify differences in design decisions.`

## Error Handling

The server normalizes common document read failures into structured errors such as:

- `invalid_input`
- `unsupported_type`
- `permission_denied`
- `not_found`
- `rate_limited`
- `content_too_large`
- `upstream_error`

This makes it easier for MCP clients and agents to handle Feishu API failures predictably.

## Limitations

- `rich` mode is optimized for readability, not perfect visual fidelity
- `docx` blocks are converted to Markdown with a conservative renderer
- Images, attachments, tables, and unsupported block types may be represented as placeholders
- Legacy `doc` rich content is normalized for readability and may not preserve all original formatting semantics

## Development

Type-check:

```bash
pnpm exec tsc --noEmit
```

Run in stdio mode:

```bash
MCP_TRANSPORT=stdio pnpm start
```

Run in HTTP mode:

```bash
MCP_TRANSPORT=http pnpm start
```

## Troubleshooting

### The MCP client cannot connect

Check:

- The absolute path in the `npx tsx /ABSOLUTE/PATH/.../src/index.ts` command is correct
- `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are set
- `MCP_TRANSPORT=stdio` is set for stdio-based clients
- Your MCP client supports stdio MCP correctly

### The server starts but no spaces or documents are returned

Check:

- Your Feishu app scopes are correct
- The target resources were shared with or authorized to the app
- You are using the correct tenant/app credentials

### A wiki link does not resolve

Check:

- The URL is a valid Feishu Wiki or Docs URL
- The app has permission to access the target node
- The target resource is really a supported document type

### HTTP mode works locally but not from another machine

That is expected with the secure default configuration.

The server binds to `127.0.0.1` by default. If you change that, you are responsible for proper network exposure controls and authentication.

## License

MIT
