export function parseReleaseNotes(sources: Record<string, string>) {
  return Object.entries(sources)
    .flatMap(([path, body]) => {
      const match = path.match(/\/v(\d+\.\d+\.\d+)\.md$/);
      return match ? [{ version: match[1], body: body.trim() }] : [];
    })
    .sort((a, b) =>
      b.version.localeCompare(a.version, undefined, { numeric: true }),
    );
}
