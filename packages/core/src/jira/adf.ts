/**
 * Jira Cloud returns descriptions and comments as Atlassian Document Format —
 * a JSON tree, not markdown. This walks the node types that actually show up in
 * practice and renders markdown. Unknown nodes recurse into their children
 * rather than being dropped, so new node types degrade to plain text.
 */

export interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

function applyMarks(text: string, marks: AdfNode['marks']): string {
  if (!marks?.length) {
    return text;
  }
  // A markdown delimiter has to sit flush against the text it marks — `** bold**`
  // renders as literal asterisks. ADF puts that padding inside the marked node,
  // so lift the surrounding whitespace out and wrap only the core.
  const padding = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  if (!padding) {
    return text;
  }
  const [, lead, core, trail] = padding;
  if (!core) {
    return text;
  }
  let out = core;
  for (const mark of marks) {
    switch (mark.type) {
      case 'strong':
        out = `**${out}**`;
        break;
      case 'em':
        out = `*${out}*`;
        break;
      case 'code':
        out = `\`${out}\``;
        break;
      case 'strike':
        out = `~~${out}~~`;
        break;
      case 'link': {
        const href = mark.attrs?.href;
        out = href ? `[${out}](${String(href)})` : out;
        break;
      }
      default:
        break;
    }
  }
  return `${lead}${out}${trail}`;
}

/**
 * Placeholder markdown image for an inline attachment, pointing at the
 * *filename* rather than the media node's own id.
 *
 * ADF identifies an inline image by a Media Platform id, which has no
 * relationship to the classic `/rest/api/3/attachment` id the REST API
 * actually serves bytes from — the only thing the two share is the filename.
 * `adfToMarkdown` stays free of the network, so it leaves this token for
 * `JiraClient` to resolve against the issue's attachment list, once, only for
 * the ticket somebody actually opened.
 */
export function jiraMediaToken(filename: string): string {
  return `![${filename.replace(/[[\]]/g, '')}](jira-media:${encodeURIComponent(filename)})`;
}

/** Matches what `jiraMediaToken` writes: `alt`, then the encoded filename. */
export const JIRA_MEDIA_PATTERN = /!\[([^\]]*)\]\(jira-media:([^)]+)\)/g;

function renderMedia(node: AdfNode): string {
  const alt = node.attrs?.alt;
  // Only a real filename can be correlated back to an attachment later; an id
  // with nothing else to go on stays the plain-text note it always was.
  if (typeof alt === 'string' && alt.trim()) {
    return jiraMediaToken(alt.trim());
  }
  return `_(attachment: ${String(node.attrs?.id ?? 'file')})_`;
}

function children(node: AdfNode, separator = ''): string {
  return (node.content ?? []).map((child) => render(child)).join(separator);
}

function renderList(node: AdfNode, marker: (index: number) => string): string {
  return (node.content ?? [])
    .map((item, index) => {
      const body = children(item, '\n').trim();
      const [first, ...rest] = body.split('\n');
      const indent = ' '.repeat(marker(index).length);
      return [`${marker(index)}${first ?? ''}`, ...rest.map((line) => `${indent}${line}`)].join('\n');
    })
    .join('\n');
}

function render(node: AdfNode): string {
  switch (node.type) {
    case 'doc':
      return children(node, '\n\n');
    case 'paragraph':
      return children(node);
    case 'text':
      return applyMarks(node.text ?? '', node.marks);
    case 'hardBreak':
      return '\n';
    case 'heading': {
      const level = Number(node.attrs?.level ?? 1);
      return `${'#'.repeat(Math.min(level, 6))} ${children(node)}`;
    }
    case 'bulletList':
      return renderList(node, () => '- ');
    case 'orderedList':
      return renderList(node, (i) => `${i + 1}. `);
    case 'listItem':
      return children(node, '\n');
    case 'taskList':
      return (node.content ?? [])
        .map((item) => `- [${item.attrs?.state === 'DONE' ? 'x' : ' '}] ${children(item)}`)
        .join('\n');
    case 'taskItem':
      return children(node);
    case 'codeBlock': {
      const language = String(node.attrs?.language ?? '');
      return `\`\`\`${language}\n${children(node)}\n\`\`\``;
    }
    case 'blockquote':
      return children(node, '\n')
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
    case 'panel':
      return children(node, '\n\n')
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
    case 'rule':
      return '---';
    case 'inlineCard':
    case 'blockCard': {
      const url = node.attrs?.url;
      return url ? `<${String(url)}>` : '';
    }
    case 'mediaSingle':
    case 'mediaGroup':
      return children(node, '\n');
    case 'media':
      return renderMedia(node);
    case 'mention':
      return `@${String(node.attrs?.text ?? 'someone').replace(/^@/, '')}`;
    case 'emoji':
      return renderEmoji(node);
    case 'table':
      return renderTable(node);
    case 'status':
      return `\`${String(node.attrs?.text ?? '')}\``;
    case 'date':
      return String(node.attrs?.timestamp ?? '');
    default:
      return children(node, '\n');
  }
}

/**
 * Atlassian's own emoji (item 102) have no Unicode character, so Jira sends
 * only a short name — `:flag_on:` on the comment Jira writes when a ticket is
 * flagged — and that is what used to show. These are the ones Jira itself
 * uses, plus the common short names people type, as the nearest emoji.
 */
const EMOJI: Record<string, string> = {
  flag_on: '🚩', flag_off: '🏳️', check_mark: '✅', cross_mark: '❌', warning: '⚠️', info: 'ℹ️',
  question: '❓', light_bulb_on: '💡', light_bulb_off: '💡', thumbsup: '👍', thumbsdown: '👎',
  '+1': '👍', '-1': '👎', star: '⭐', plus: '➕', minus: '➖', smile: '😄', smiley: '😃', grinning: '😀',
  slight_smile: '🙂', wink: '😉', sad: '🙁', frowning: '🙁', cry: '😢', tongue: '😛', heart: '❤️',
  tada: '🎉', fire: '🔥', rocket: '🚀', eyes: '👀', pray: '🙏', clap: '👏', ok_hand: '👌', wave: '👋',
  white_check_mark: '✅', heavy_check_mark: '✔️', x: '❌', exclamation: '❗', bangbang: '‼️',
  red_circle: '🔴', green_circle: '🟢', yellow_circle: '🟡', blue_circle: '🔵', bug: '🐛',
  lock: '🔒', unlock: '🔓', memo: '📝', pushpin: '📌', link: '🔗', hourglass: '⌛', stopwatch: '⏱️',
  100: '💯', muscle: '💪', thinking: '🤔', sweat_smile: '😅', joy: '😂', laughing: '😆'
};

function renderEmoji(node: AdfNode): string {
  const text = typeof node.attrs?.text === 'string' ? node.attrs.text : '';
  const short = typeof node.attrs?.shortName === 'string' ? node.attrs.shortName : '';
  // A real character is used as is; a `:name:` in either field is looked up.
  if (text && !/^:[^:\s]+:$/.test(text)) return text;
  const name = (text || short).replace(/^:|:$/g, '').toLowerCase();
  return EMOJI[name] ?? (text || short);
}

function renderTable(node: AdfNode): string {
  const rows = (node.content ?? []).map((row) =>
    (row.content ?? []).map((cell) => children(cell, ' ').replace(/\n/g, ' ').trim())
  );
  if (rows.length === 0) {
    return '';
  }
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (row: string[]) => {
    const filled = [...row];
    while (filled.length < width) {
      filled.push('');
    }
    return `| ${filled.join(' | ')} |`;
  };
  const [header, ...body] = rows;
  return [pad(header), `| ${Array(width).fill('---').join(' | ')} |`, ...body.map(pad)].join('\n');
}

export function adfToMarkdown(doc: unknown): string {
  if (!doc) {
    return '';
  }
  if (typeof doc === 'string') {
    return doc;
  }
  const node = doc as AdfNode;
  if (!node.type) {
    return '';
  }
  return render(node).replace(/\n{3,}/g, '\n\n').trim();
}

/** Wraps plain text back into a minimal ADF document for the comment endpoint. */
export function markdownToAdf(text: string): AdfNode {
  return {
    type: 'doc',
    version: 1,
    content: text.split(/\n{2,}/).map((paragraph) => ({
      type: 'paragraph',
      content: paragraph
        .split('\n')
        .flatMap((line, index) =>
          index === 0
            ? [{ type: 'text', text: line }]
            : [{ type: 'hardBreak' }, { type: 'text', text: line }]
        )
        .filter((n) => n.type !== 'text' || n.text)
    }))
  } as AdfNode & { version: number };
}
