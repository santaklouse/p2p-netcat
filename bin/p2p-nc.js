#!/usr/bin/env node

try {
  await import('../src/runtime.js')
  const { main } = await import('../src/cli.js')
  await main()
} catch (error) {
  process.stderr.write(`[p2p-nc] ошибка: ${error.message}\n`)
  process.exitCode = 1
}

await Promise.all([
  new Promise(resolve => process.stdout.write('', resolve)),
  new Promise(resolve => process.stderr.write('', resolve))
])

process.exit(process.exitCode ?? 0)
