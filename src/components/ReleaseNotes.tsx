import type { ReactNode } from "react";

function inline(text: string): ReactNode {
  return text
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
    .map((part, index) =>
      /^\*\*[^*]+\*\*$/.test(part) ? (
        <strong key={index}>{part.slice(2, -2)}</strong>
      ) : /^`[^`]+`$/.test(part) ? (
        <code key={index}>{part.slice(1, -1)}</code>
      ) : (
        part
      ),
    );
}

/** A small, text-only renderer for the headings, lists and paragraphs in releases. */
export function ReleaseNotes({ body }: { body?: string }) {
  const lines = (body?.trim() || "No release notes were provided.").split(
    /\r?\n/,
  );
  if (/^#\s+Kitsune\b/i.test(lines[0])) lines.shift();
  const blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i].trim();
    if (!line) {
      i++;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      blocks.push(<h4 key={i}>{inline(line.replace(/^#{1,6}\s+/, ""))}</h4>);
      i++;
      continue;
    }
    if (/^[-*]\s/.test(line)) {
      const items: string[] = [];
      const key = i;
      while (i < lines.length && /^[-*]\s/.test(lines[i].trim()))
        items.push(lines[i++].trim().slice(2));
      blocks.push(
        <ul key={key}>
          {items.map((item, index) => (
            <li key={index}>{inline(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    const paragraph: string[] = [];
    const key = i;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(?:#{1,6}|[-*])\s/.test(lines[i].trim())
    )
      paragraph.push(lines[i++].trim());
    blocks.push(<p key={key}>{inline(paragraph.join(" "))}</p>);
  }
  return <div className="release-notes-content">{blocks}</div>;
}
