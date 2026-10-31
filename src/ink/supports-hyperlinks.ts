import supportsHyperlinksLib from 'supports-hyperlinks'

/**
 * Terminals that support OSC 8 hyperlinks but are not detected by the
 * supports-hyperlinks library. Checked against both TERM_PROGRAM and
 * LC_TERMINAL (the latter is preserved inside tmux).
 */
export const ADDITIONAL_HYPERLINK_TERMINALS = [
  'ghostty',
  'Hyper',
  'kitty',
  'alacritty',
  'iTerm.app',
  'iTerm2',
  'rio',
]

/**
 * Terminals that accept OSC 8 but hand every target to the OS opener instead
 * of understanding our own `dsh-file:` scheme: rio dispatches OSC 8 clicks
 * through `open` (its hint rules treat an OSC 8 target as a URL), and macOS
 * has no handler for `dsh-file:`. Emitting our file links there would turn a
 * working plain path into a dead click, so file targets stay plain text and
 * rio's own path hints keep opening them.
 */
const NO_FILE_SCHEME_TERMINALS = ['rio']

type EnvLike = Record<string, string | undefined>

type SupportsHyperlinksOptions = {
  env?: EnvLike
  stdoutSupported?: boolean
}

/**
 * Returns whether stdout supports OSC 8 hyperlinks.
 * Extends the supports-hyperlinks library with additional terminal detection.
 * @param options Optional overrides for testing (env, stdoutSupported)
 * @returns true when stdout or the detected terminal supports hyperlinks.
 */
export function supportsHyperlinks(
  options?: SupportsHyperlinksOptions,
): boolean {
  const stdoutSupported =
    options?.stdoutSupported ?? supportsHyperlinksLib.stdout
  if (stdoutSupported) {
    return true
  }

  const env = options?.env ?? process.env

  // Check for additional terminals not detected by supports-hyperlinks
  const termProgram = env['TERM_PROGRAM']
  if (termProgram && ADDITIONAL_HYPERLINK_TERMINALS.includes(termProgram)) {
    return true
  }

  // LC_TERMINAL is set by some terminals (e.g. iTerm2) and preserved inside tmux,
  // where TERM_PROGRAM is overwritten to 'tmux'.
  const lcTerminal = env['LC_TERMINAL']
  if (lcTerminal && ADDITIONAL_HYPERLINK_TERMINALS.includes(lcTerminal)) {
    return true
  }

  // Kitty sets TERM=xterm-kitty
  const term = env['TERM']
  if (term?.includes('kitty')) {
    return true
  }

  return false
}

/**
 * Returns whether the terminal can open our own `dsh-file:` links, which is
 * stricter than OSC 8 support: the terminal must hand the target back to the
 * TUI instead of resolving it through the OS opener. Terminals in
 * `NO_FILE_SCHEME_TERMINALS` resolve everything themselves, so file targets
 * there stay plain text (their own path hints still open them).
 * @param options Optional overrides for testing (env, stdoutSupported)
 * @returns true when file paths may be emitted as `dsh-file:` OSC 8 links.
 */
export function supportsFileLinkScheme(
  options?: SupportsHyperlinksOptions,
): boolean {
  if (!supportsHyperlinks(options)) {
    return false
  }
  const env = options?.env ?? process.env
  const termProgram = (env['TERM_PROGRAM'] ?? '').toLowerCase()
  const lcTerminal = (env['LC_TERMINAL'] ?? '').toLowerCase()
  return !NO_FILE_SCHEME_TERMINALS.some(
    terminal => terminal === termProgram || terminal === lcTerminal,
  )
}
