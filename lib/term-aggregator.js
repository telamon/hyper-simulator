const { BasicTimeline } = require('hypersim-parser')
const clearEsc = '\033[2J'

module.exports = function SimpleTermAggregator () {
  const parser = new BasicTimeline({ binary: false })
  parser.on('snapshot', printSnapshot)
  parser.setReducer('custom', (v, ev, c, glob) => {
    if (ev.type !== 'custom') return glob.customCounts || {}
    if (!glob.customCounts) glob.customCounts = {}
    const counts = glob.customCounts
    if (!counts[ev.event]) counts[ev.event] = 0
    counts[ev.event]++
    return counts
  })
  return chunk => { parser.write(chunk) }
}

function printSnapshot (snap) {
  const { stats, peers, links, custom } = snap
  console.log(`${clearEsc}____.-  H Y P E R - S I M U L A T O R  -.____`)
  console.log('====-------------------------------------====\n')
  console.log(`State: ${snap.state} Speed: ${snap.conf.speed}x Interval: ${snap.conf.interval}ms`)
  console.log(`Iteration: ${snap.iteration}\t\t SimTime: ${Math.floor(stats.time/1000)}s`)
  console.log(`Peers: ${peers.length}\t\t Pending: ${stats.pending}`)
  console.log(`Conn: ${links.length} \t\t Interconnection: ${stats.interconnection.toFixed(2)}`)
  console.log(`Swarm: ${stats.rate >> 8}KBps / ${stats.load.toFixed(2)}`)
  if (Object.keys(custom)) {
    console.log('\nCustom events counts:')
    for (const name of Object.keys(custom)) {
      console.log(`'${name}'\t x${custom[name]}`)
    }
  }
  console.log('\n====-------------------------------------====')
  debugger
}
