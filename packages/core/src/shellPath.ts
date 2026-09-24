/**
 * A path as a shell word, the way Terminal.app writes a dropped file:
 * backslashes before spaces and shell punctuation. Claude Code recognises an
 * image path written like this and attaches the image — which is how a file
 * dropped or an image pasted into a Baton terminal reaches it.
 */
export function shellPath(file: string): string {
  return file.replace(/([ \t'"\\()&;|<>$`!*?[\]{}#])/g, '\\$1');
}
