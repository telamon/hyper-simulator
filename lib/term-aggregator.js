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

  /* Total upload/download stats
   * parser.pushReducer('peers', (v, ev, c, p) => {
    if (ev.type !== 'peer' && ev.event !== 'tick') return v
  }) */

  return chunk => { parser.write(chunk) }
}
// let endl = Array.from(new Array(6)).map(() => '_.-\'"`-.').join('').split('')
 let endl = '====---------------========---------------===='.split('')
function printSnapshot (snap) {
  const { stats, peers, links, custom } = snap
  console.log(`${clearEsc}____.-  H Y P E R - S I M U L A T O R  -.____`)
  console.log('====-------------------------------------====\n')
  console.log(`State: ${snap.state} Speed: ${snap.conf.speed}x Interval: ${snap.conf.interval}ms`)
  console.log(`Iteration: ${snap.iteration}\t\t SimTime: ${Math.floor(stats.time/1000)}s`)
  console.log(`Peers: ${peers.length}\t\t Pending: ${stats.pending}`)
  console.log(`Conn: ${links.length} \t\t Interconnection: ${stats.interconnection.toFixed(2)}`)
  console.log(`Swarm: ${stats.rate >> 8}KBps / ${stats.load.toFixed(2)}`)

  {
    console.log('\nPeers')
    console.log('-------')
    for (const peer of peers.sort((a, b) => a.id < b.id)) {
      const state = peer.finished ? 'done' :  'active'
      console.log(`${peer.id}#${peer.name.padEnd(12)}\t ${state}\tconn: ${peer.connectionCount}/${peer.maxConnections}  rate: ${(peer.rx + peer.tx) >> 8}KBps`)
    }
    console.log('')
  }

  if (false) {
    console.log('\nConnections')
    console.log('-------')
    for (const l of links.sort((a,b) => a.id < b.id)) {
      const state = l.noop ? 'idle' : ( l.txEnd || l.rxEnd ? 'closing' : 'active')
      console.log(`${l.id}\t ${state} rate: ${(l.rx + l.tx) >> 8}KBps`)
    }
    console.log('')
  }

  if (Object.keys(custom)) {
    console.log('\nCustom events counts')
    console.log('----------------------')
    for (const name of Object.keys(custom)) {
      console.log(`'${name}'\t x${custom[name]}`)
    }
  }
  endl.unshift(endl.pop())
  console.log('\n')
  console.log(endl.join(''), '\n')
}
