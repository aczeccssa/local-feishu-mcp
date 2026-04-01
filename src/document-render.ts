import { type DocxBlock } from './api/feishu.js';

export type RenderMode = 'markdown' | 'plain_text';

const BLOCK_FIELD_BY_TYPE: Record<number, string> = {
  1: 'page',
  2: 'text',
  3: 'heading1',
  4: 'heading2',
  5: 'heading3',
  6: 'heading4',
  7: 'heading5',
  8: 'heading6',
  9: 'heading7',
  10: 'heading8',
  11: 'heading9',
  12: 'bullet',
  13: 'ordered',
  14: 'code',
  15: 'quote',
  17: 'todo',
  19: 'callout',
  22: 'divider',
};

const CODE_LANGUAGE_BY_ID: Record<number, string> = {
  1: 'text',
  7: 'bash',
  12: 'css',
  24: 'html',
  28: 'json',
  29: 'java',
  30: 'javascript',
  39: 'markdown',
  49: 'python',
  56: 'sql',
  63: 'typescript',
  66: 'xml',
  67: 'yaml',
};

type TextPayload = {
  style?: {
    language?: number;
    done?: boolean;
    sequence?: string;
  };
  elements?: TextElement[];
};

type TextElementStyle = {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  inline_code?: boolean;
  link?: {
    url?: string;
  };
};

type TextElement = {
  text_run?: {
    content?: string;
    text_element_style?: TextElementStyle;
  };
  mention_user?: {
    user_id?: string;
  };
  mention_doc?: {
    title?: string;
    url?: string;
    token?: string;
  };
  reminder?: {
    expire_time?: string;
  };
  equation?: {
    content?: string;
  };
  file?: {
    file_token?: string;
  };
  inline_file?: {
    file_token?: string;
  };
  inline_block?: {
    block_id?: string;
  };
  text_element_style?: TextElementStyle;
};

function getBlockChildren(block: DocxBlock): string[] {
  return Array.isArray(block.children)
    ? block.children.filter((item): item is string => typeof item === 'string')
    : [];
}

function getBlockPayload(block: DocxBlock): TextPayload | null {
  const field = BLOCK_FIELD_BY_TYPE[block.block_type];
  if (!field) {
    return null;
  }

  const payload = block[field];
  return payload && typeof payload === 'object' ? (payload as TextPayload) : null;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ');
}

function applyTextStyle(
  content: string,
  style: TextElementStyle | undefined,
  mode: RenderMode,
): string {
  if (!content) {
    return '';
  }

  if (mode === 'plain_text' || !style) {
    return content;
  }

  let rendered = content;

  if (style.inline_code) {
    rendered = `\`${rendered}\``;
  }
  if (style.bold) {
    rendered = `**${rendered}**`;
  }
  if (style.italic) {
    rendered = `*${rendered}*`;
  }
  if (style.strikethrough) {
    rendered = `~~${rendered}~~`;
  }
  if (style.underline) {
    rendered = `<u>${rendered}</u>`;
  }
  if (style.link?.url) {
    rendered = `[${rendered}](${style.link.url})`;
  }

  return rendered;
}

function renderTextElement(element: TextElement, mode: RenderMode): string {
  const inlineStyle = element.text_run?.text_element_style || element.text_element_style;

  if (element.text_run?.content) {
    return applyTextStyle(normalizeWhitespace(element.text_run.content), inlineStyle, mode);
  }

  if (element.mention_user?.user_id) {
    return applyTextStyle(`@${element.mention_user.user_id}`, inlineStyle, mode);
  }

  if (element.mention_doc) {
    const title = element.mention_doc.title || element.mention_doc.token || '文档';
    const rendered =
      mode === 'markdown' && element.mention_doc.url
        ? `[${title}](${element.mention_doc.url})`
        : title;
    return applyTextStyle(rendered, inlineStyle, mode);
  }

  if (element.reminder?.expire_time) {
    const timestamp = Number.parseInt(element.reminder.expire_time, 10);
    const readableTime = Number.isFinite(timestamp)
      ? new Date(timestamp).toISOString()
      : element.reminder.expire_time;
    return applyTextStyle(`[提醒 ${readableTime}]`, inlineStyle, mode);
  }

  if (element.equation?.content) {
    const rendered =
      mode === 'markdown' ? `$${element.equation.content}$` : element.equation.content;
    return applyTextStyle(rendered, inlineStyle, mode);
  }

  const fileToken = element.inline_file?.file_token || element.file?.file_token;
  if (fileToken) {
    return applyTextStyle(`[附件 ${fileToken}]`, inlineStyle, mode);
  }

  if (element.inline_block?.block_id) {
    return applyTextStyle(`[内联块 ${element.inline_block.block_id}]`, inlineStyle, mode);
  }

  return '';
}

function renderTextPayload(payload: TextPayload | null, mode: RenderMode): string {
  if (!payload?.elements?.length) {
    return '';
  }

  return payload.elements
    .map(element => renderTextElement(element, mode))
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function indentLines(value: string, prefix: string): string {
  return value
    .split('\n')
    .map(line => (line ? `${prefix}${line}` : prefix.trimEnd()))
    .join('\n');
}

function renderNonTextBlock(block: DocxBlock, mode: RenderMode): string {
  const label = (() => {
    switch (block.block_type) {
      case 18:
        return '多维表格';
      case 20:
        return '会话卡片';
      case 21:
        return '流程图/UML';
      case 23:
        return '文件';
      case 24:
        return '分栏';
      case 25:
        return '分栏列';
      case 26:
        return '内嵌网页';
      case 27:
        return '图片';
      case 28:
        return '开放平台小组件';
      case 30:
        return '电子表格';
      case 31:
        return '表格';
      case 32:
        return '表格单元格';
      case 33:
        return '视图';
      case 34:
        return '引用容器';
      case 36:
        return 'OKR';
      case 40:
        return '文档小组件';
      case 41:
        return 'Jira 问题';
      case 42:
      case 51:
        return 'Wiki 子页面列表';
      case 43:
        return '画板';
      case 48:
        return '链接预览';
      case 49:
        return '源同步块';
      case 50:
        return '引用同步块';
      default:
        return `未支持块类型 ${block.block_type}`;
    }
  })();

  return mode === 'markdown' ? `[${label}]` : label;
}

function renderBlock(
  blockId: string,
  blockMap: Map<string, DocxBlock>,
  mode: RenderMode,
  depth = 0,
): string[] {
  const block = blockMap.get(blockId);
  if (!block) {
    return [];
  }

  const payload = getBlockPayload(block);
  const text = renderTextPayload(payload, mode);
  const children = getBlockChildren(block).flatMap(childId =>
    renderBlock(childId, blockMap, mode, depth + 1),
  );
  const nestedIndent = '  '.repeat(Math.max(depth, 0));

  switch (block.block_type) {
    case 1:
      return children;
    case 2:
      return [text, ...children].filter(Boolean);
    case 3:
    case 4:
    case 5:
    case 6:
    case 7:
    case 8:
    case 9:
    case 10:
    case 11: {
      const level = Math.min(6, block.block_type - 2);
      const line = mode === 'markdown' ? `${'#'.repeat(level)} ${text}` : text;
      return [line, ...children].filter(Boolean);
    }
    case 12: {
      const line = mode === 'markdown' ? `${nestedIndent}- ${text}` : `${nestedIndent}- ${text}`;
      return [line, ...children].filter(Boolean);
    }
    case 13: {
      const line = mode === 'markdown' ? `${nestedIndent}1. ${text}` : `${nestedIndent}1. ${text}`;
      return [line, ...children].filter(Boolean);
    }
    case 14: {
      const languageId = payload?.style?.language;
      const language = languageId ? CODE_LANGUAGE_BY_ID[languageId] || 'text' : 'text';
      const line = mode === 'markdown' ? `\`\`\`${language}\n${text}\n\`\`\`` : text;
      return [line, ...children].filter(Boolean);
    }
    case 15: {
      const line =
        mode === 'markdown' ? indentLines(text || '', '> ') : indentLines(text || '', '');
      return [line, ...children].filter(Boolean);
    }
    case 17: {
      const done = Boolean(payload?.style?.done);
      const line =
        mode === 'markdown'
          ? `${nestedIndent}- [${done ? 'x' : ' '}] ${text}`
          : `${nestedIndent}${done ? '[x]' : '[ ]'} ${text}`;
      return [line, ...children].filter(Boolean);
    }
    case 19: {
      const line = mode === 'markdown' ? `> [!NOTE]\n> ${text}` : `[提示] ${text}`;
      return [line, ...children].filter(Boolean);
    }
    case 22:
      return [mode === 'markdown' ? '---' : '----------------'];
    default: {
      const placeholder = renderNonTextBlock(block, mode);
      return [placeholder, ...children].filter(Boolean);
    }
  }
}

export function renderDocxBlocks(blocks: DocxBlock[], mode: RenderMode): string {
  if (!blocks.length) {
    return '';
  }

  const blockMap = new Map<string, DocxBlock>(blocks.map(block => [block.block_id, block]));
  const pageBlock =
    blocks.find(block => block.block_type === 1) ||
    blocks.find(block => !block.parent_id) ||
    blocks[0];

  const rootChildIds = getBlockChildren(pageBlock);
  const renderedBlocks = (rootChildIds.length ? rootChildIds : [pageBlock.block_id])
    .flatMap(blockId => renderBlock(blockId, blockMap, mode))
    .map(line => line.trimEnd())
    .filter(Boolean);

  const separator = mode === 'markdown' ? '\n\n' : '\n';
  return renderedBlocks
    .join(separator)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function derivePlainTextFromDocxBlocks(blocks: DocxBlock[]): string {
  return renderDocxBlocks(blocks, 'plain_text');
}

export function deriveMarkdownFromDocxBlocks(blocks: DocxBlock[]): string {
  return renderDocxBlocks(blocks, 'markdown');
}
