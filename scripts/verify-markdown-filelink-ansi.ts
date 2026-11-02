/**
 * Markdown 文件链接 ANSI 完整性回归。
 *
 * renderCodeSpan 曾把【已上色的】路径代码段直接作为 content 传给
 * createHyperlink——其防注入消毒会把合法 `\x1b` 剥掉，SGR 参数文本
 * （`[38;2;…m` / `[39m`）原样上屏（浅色主题 permission `#3F6CC4` 场景）。
 * 回归断言：路径代码段输出要么带完整 `\x1b` 序列、要么无任何参数残片；
 * 样式化链接标签（加粗等）同样不得残留 `[1m` 等裸参数。
 * 同时覆盖文件链接降级的转义清理与代码里的全屏 URL 点击边界。
 *
 * Run: node --import tsx/esm scripts/verify-markdown-filelink-ansi.ts
 */

// supportsHyperlinks 在模块加载时缓存 stdout 探测结果；TERM_PROGRAM=kitty
// 走 wrapper 的附加终端名单，保证 OSC 8 路径被覆盖且不依赖运行环境。
process.env.TERM_PROGRAM = 'kitty'

const { default: chalk } = await import('chalk')
const { applyMarkdown } = await import('../src/terminal-utils/markdown.js')
const { createHyperlink } = await import('../src/terminal-utils/hyperlink.js')
const React = await import('react')
const { Markdown } = await import('../src/components/Markdown.js')
const { StreamingMarkdown } = await import('../src/components/StreamingMarkdown.js')
const { renderToScreen } = await import('../src/ink/render-to-screen.js')
const { cellAtIndex } = await import('../src/ink/screen.js')
const { findPlainTextUrlAt } = await import('../src/ink/selection.js')
const { Box } = await import('../src/ui.js')
const { TerminalSizeContext } = await import('../src/ink/components/TerminalSizeContext.js')
const { classifyOpenTarget } = await import('../src/utils/urlGuard.js')
const { setActiveThemeName } = await import('../src/theme.js')

let failures = 0
let checks = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  checks += 1
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === '' ? '' : `: ${detail}`}`)
}

function markdownScreen(source: string, width = 100) {
  const tree = React.createElement(
    TerminalSizeContext.Provider,
    { value: { columns: width, rows: 40 } },
    React.createElement(Box, { flexDirection: 'column', width },
      React.createElement(Markdown, { children: source })),
  )
  const { screen, height } = renderToScreen(tree, width)
  const cells = Array.from({ length: width * height }, (_, index) => cellAtIndex(screen, index))
  return { screen, cells }
}

const prevLevel = chalk.level
chalk.level = 3 // truecolor（38;2;r;g;b）；level 2 会把 rgb 降级成 256 色

try {
  // Ordinary slash-delimited prose must not acquire an OSC 8 file target.
  // Exercise the real Markdown text path, not just looksLikeFilePath.
  for (const text of ['working/idle/needs-input state,', '2024/01/15', '工作/空闲/等待输入']) {
    const prose = applyMarkdown(text)
    check(`正文不产生文件链接：${text}`, !prose.includes('dsh-file:'), JSON.stringify(prose))
  }
  const mixed = applyMarkdown('working/idle/needs-input state, see src/utils/fileTarget.ts')
  check(
    '正文误匹配被拒绝后仍识别后续真实路径',
    !mixed.includes('dsh-file:%2Fidle') && mixed.includes('dsh-file:src%2Futils%2FfileTarget.ts'),
    JSON.stringify(mixed),
  )
  const explicit = applyMarkdown('[working/idle/needs-input](file:///tmp/state)')
  check(
    '显式 Markdown 文件链接保留原目标且不嵌套自动链接',
    explicit.includes('file:///tmp/state') && !explicit.includes('dsh-file:'),
    JSON.stringify(explicit),
  )

  const source = 'working/idle/needs-input state,\n\nsrc/utils/fileTarget.ts'
  for (const [name, Component] of [['Markdown', Markdown], ['StreamingMarkdown', StreamingMarkdown]] as const) {
    for (const width of [24, 80]) {
      const { screen, height } = renderToScreen(React.createElement(Component, { children: source }), width)
      const cells = Array.from({ length: width * height }, (_, index) => cellAtIndex(screen, index))
      const linked = cells.filter(cell => cell.hyperlink !== undefined)
      check(
        `${name} ${width} 列屏幕保留完整正文`,
        cells.map(cell => cell.char).join('').replace(/\s/gu, '') === source.replace(/\s/gu, ''),
      )
      check(
        `${name} ${width} 列屏幕仅真实路径可点击`,
        linked.length > 0 &&
          linked.every(cell => cell.hyperlink === 'dsh-file:src%2Futils%2FfileTarget.ts') &&
          linked.map(cell => cell.char).join('') === 'src/utils/fileTarget.ts',
      )
      if (Component === Markdown && width === 80) {
        const rows = Array.from({ length: height }, (_, row) =>
          cells.slice(row * width, (row + 1) * width).map(cell => cell.char).join('').trimEnd(),
        )
        console.log(`Rendered screen (${width} columns):\n${rows.join('\n')}`)
      }
    }
  }

  // ── renderCodeSpan 端到端：路径内联代码 ─────────────────────────────
  const out = applyMarkdown('看 `src/dsh-adapter/plugin.ts` 这个文件')
  const bareSgr = (out.match(/\[38;2;/g) ?? []).length
  const escSgr = (out.match(/\u001b\[38;2;/g) ?? []).length
  check(
    '路径代码段不残留裸 SGR 参数文本（每个 [38;2; 都必须带 ESC 前缀）',
    bareSgr === escSgr,
    JSON.stringify(out),
  )
  check(
    '路径代码段保留完整真彩色 ESC 序列',
    out.includes('\u001b[38;2;') && out.includes('src/dsh-adapter/plugin.ts\u001b[39m'),
    JSON.stringify(out),
  )
  check(
    '路径代码段带 OSC 8 超链接（kitty 环境）',
    out.includes('\u001b]8;;dsh-file:'),
    JSON.stringify(out),
  )

  // ── renderLink：带样式的链接标签 ───────────────────────────────────
  const linkOut = applyMarkdown('去 [**加粗链接**](https://example.com/x) 看看')
  check(
    '样式化链接标签不残留 [1m/[22m 裸参数',
    !linkOut.includes('[1m') && !linkOut.includes('[22m'),
    JSON.stringify(linkOut),
  )

  // ── createHyperlink 直接契约 ────────────────────────────────────────
  const paint = (text: string): string => `\u001b[38;2;63;108;196m${text}\u001b[39m`
  const withPainted = createHyperlink('dsh-file:///x', paint('src/dsh-adapter/plugin.ts'), {
    supportsHyperlinks: true,
    style: (text: string) => text,
  })
  check(
    '已上色 content 被完整消毒：SGR 序列全剥、仅剩 OSC 8 包裹与纯文本',
    !withPainted.includes('\u001b[38;') &&
      !withPainted.includes('[38;2;') &&
      withPainted.includes('src/dsh-adapter/plugin.ts'),
    JSON.stringify(withPainted),
  )
  const withStyle = createHyperlink('dsh-file:///x', 'src/dsh-adapter/plugin.ts', {
    supportsHyperlinks: true,
    style: paint,
  })
  check(
    'style 回调在消毒后上色：ESC 完整、OSC 8 包裹',
    withStyle.includes(
      '\u001b]8;;dsh-file:///x\u0007\u001b[38;2;63;108;196msrc/dsh-adapter/plugin.ts\u001b[39m\u001b]8;;\u0007',
    ),
    JSON.stringify(withStyle),
  )

  // ── 默认链接色跟随主题 accent（不再是固定 ANSI 蓝）──────────────────
  setActiveThemeName('light')
  const themedLink = createHyperlink('https://example.com/x', 'example', {
    supportsHyperlinks: true,
  })
  check(
    '默认链接色取主题 accent（light = #3F6CC4）',
    themedLink.includes('\u001b[38;2;63;108;196mexample\u001b[39m'),
    JSON.stringify(themedLink),
  )
  check(
    '默认链接仍带成对 OSC 8 包裹、不再固定 34m 蓝',
    themedLink.startsWith('\u001b]8;;https://example.com/x\u0007') &&
      themedLink.endsWith('\u001b]8;;\u0007') &&
      !themedLink.includes('\u001b[34m'),
    JSON.stringify(themedLink),
  )
  setActiveThemeName('dark-ansi')
  const ansiLink = createHyperlink('https://example.com/x', 'example', {
    supportsHyperlinks: true,
  })
  check(
    'ANSI 主题的链接色退回 16 色（accent = ansi:blueBright）',
    ansiLink.includes('\u001b[94mexample\u001b[39m'),
    JSON.stringify(ansiLink),
  )

  // ── 折行不丢色 ──────────────────────────────────────────────────────
  // 代码注释与 docs/themes.md 曾把「真彩链接折行处丢色」写成已知取舍；实测
  // wrap-ansi 10 在续行重发 SGR 并补齐 OSC 8，取舍不成立。这里钉住
  // 渲染器真正使用的折行入口（wrap 样式 = trim:false + hard:true）。
  setActiveThemeName('dark')
  const { wrapAnsi } = await import('../src/ink/wrapAnsi.js')
  const longLink = createHyperlink(
    'https://example.com/x',
    'dsh-tui-theme-plugin-link-label',
    { supportsHyperlinks: true },
  )
  const wrappedLink = wrapAnsi(longLink, 14, { trim: false, hard: true }).split('\n')
  check(
    '真彩链接折行后每一条续行仍带 accent SGR 与 OSC 8 打开序列',
    wrappedLink.length > 1 &&
      wrappedLink.slice(1).every(line =>
        line.includes('\u001b[38;2;125;161;222m') &&
        line.includes('\u001b]8;;https://example.com/x\u0007')),
    JSON.stringify(wrappedLink),
  )
  // rio 接受 OSC 8，但会把目标原样交给系统打开器，而 `dsh-file:` 没有处理器：
  // 文件路径必须退回纯文本（交给 rio 自己的路径 hint），URL 链接照发。
  process.env.TERM_PROGRAM = 'rio'
  const rioMixed = applyMarkdown(
    '见 `src/utils/fileTarget.ts` 与 [链接](https://example.com)',
  )
  check(
    'rio 下不发 dsh-file 文件链接',
    !rioMixed.includes('dsh-file:'),
    JSON.stringify(rioMixed).slice(0, 200),
  )
  check(
    'rio 下 https 链接仍带 OSC 8',
    rioMixed.includes('\u001b]8;;https://example.com'),
    JSON.stringify(rioMixed).slice(0, 200),
  )
  // 显式 `[x](dsh-file:…)` 与生成的路径链接同一能力位：rio 下不能发出去，
  // 否则点击交给系统打开器，而 `dsh-file:` 没有处理器。
  const rioExplicit = applyMarkdown('[源码](dsh-file:src%2Futils%2FfileTarget.ts)')
  check(
    'rio 下显式 dsh-file 链接不发 OSC 8，标签保留',
    !rioExplicit.includes('\u001b]8;;dsh-file:') && rioExplicit.includes('源码'),
    JSON.stringify(rioExplicit).slice(0, 200),
  )
  for (const href of ['DSH-FILE:src%2Ffoo.ts', 'dsh-file:src%2Ffoo%ZZ.ts']) {
    for (const marker of ['', '!']) {
      const source = `${marker}[source](${href})`
      check(`rio 文件协议门禁覆盖 ${source}`, applyMarkdown(source) === 'source')
    }
  }
  check(
    '文件点击处理接受大小写不敏感的协议名',
    JSON.stringify(classifyOpenTarget('DSH-FILE:src%2Ffoo.ts')) ===
      JSON.stringify({ kind: 'file-actions', path: 'src/foo.ts' }),
  )
  for (const payload of [
    '\u001b]8;;https://example.com\u0007probe\u001b]8;;\u0007',
    '\u001b]8;;https://example.com\u001b\\probe\u001b]8;;\u001b\\',
    '\u001b[31mprobe\u001b[0m\u0000\u009c',
  ]) {
    for (const marker of ['', '!']) {
      const source = `${marker}[](dsh-file:${encodeURIComponent(payload)})`
      check('解码后的文件链接降级文本清除终端控制序列', applyMarkdown(source) === 'probe')
      const { cells } = markdownScreen(source)
      check('文件链接降级后的屏幕仅显示文本且没有隐藏超链接',
        cells.map(cell => cell.char).join('').trim() === 'probe' &&
        cells.every(cell => cell.hyperlink === undefined))
    }
  }
  check('没有标签的普通文件链接保留解码后的路径',
    applyMarkdown('[](dsh-file:src%2Ffoo.ts)') === 'src/foo.ts')
  check('无效编码的文件链接保留原始路径文本',
    applyMarkdown('[](dsh-file:src%2Ffoo%ZZ.ts)') === 'src%2Ffoo%ZZ.ts')

  // Fullscreen clicks read the screen's plain URL fallback, even when the
  // terminal itself supports OSC 8. Shell escapes must stay outside its target.
  const url = 'https://example.com'
  const shell = String.raw`printf '\e]8;;https://example.com\e\\OSC8 链接\e]8;;\e\\'`
  for (const terminal of ['rio', 'ghostty']) {
    process.env.TERM_PROGRAM = terminal
    for (const source of ['`' + shell + '`', '```sh\n' + shell + '\n```']) {
      for (const width of [60, 100]) {
        const { screen, cells } = markdownScreen(source, width)
        const text = cells.map(cell => cell.char).join('')
        const start = text.indexOf(url)
        check(`${terminal} ${width} 列代码中的 URL 可见`, start >= 0)
        if (start < 0) continue
        const row = Math.floor(start / width)
        const col = start % width
        check(`${terminal} ${width} 列 URL 每个字符都返回完整目标`,
          Array.from({ length: url.length }, (_, offset) =>
            findPlainTextUrlAt(screen, col + offset, row)).every(target => target === url))
        check(`${terminal} ${width} 列 shell 转义不属于链接点击范围`,
          findPlainTextUrlAt(screen, col + url.length, row) === undefined &&
          findPlainTextUrlAt(screen, col + url.length + 4, row) === undefined)
      }
    }
  }
  // Code blocks keep their existing ANSI output. Fullscreen clicks use the
  // plain URL fallback above; native terminal hints handle terminal-owned clicks.
  process.env.TERM_PROGRAM = 'kitty'
  const fenced = applyMarkdown('```sh\ncurl https://example.com/x \\\n  -H "a: b"\n```')
  check(
    '代码块里的 URL 保持纯文本（不生成 OSC 8）',
    !fenced.includes('\u001b]8;;'),
    JSON.stringify(fenced).slice(0, 200),
  )
} finally {
  chalk.level = prevLevel
}

console.log(`${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exit(1)
