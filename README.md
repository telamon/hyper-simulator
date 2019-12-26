# hyper-simulator

[![Build Status](https://travis-ci.org/decentstack/hyper-simulator.svg?branch=master)](https://travis-ci.org/decentstack/hyper-simulator)
[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)

> Simulate a swarm of peers running hyperswarm compatible applications

**MORE DOCS COMING SOON**

TODO:

- [ ] Refactor behaviour registration interface
- [ ] Use real hyperswarm with simulated network stack
- [ ] Use real hyperswarm with simulated dht
- [ ] Create executable `hypersim` script
- [ ] Let executable output minimal aggregation during runtime.
- [ ] Publish `hypersim-parser`
- [ ] Publish `hypersim-visualizer`

## <a name="install"></a> Install

```
npm install hyper-simulator
```

## <a name="usage"></a> Usage

Define at least one behaviour for your peers.
The interface provides you with an instance of `random-access` and
an instance of `hyperswarm`

```js
function SimulatedPeer ({ storage, swarm, signal }, end) {
  const feed = hypercore(storage)

  feed.ready(() => {
    // Setup swarm
    swarm.join(feed.key, { lookup: true, announce: true })

    swarm.on('connection', (socket, { client }) => {
      // Initiate Replication
      socket
        .pipe(feed.replicate(client))
        .pipe(socket)
    })
  })

  // Append your custom 'version' metric to swarm-log that
  // can be used to visualize the distribution of data.
  feed.on('download', seq => {
    signal('version', { seq })

    // The entire simulation can optionally be ended when
    // all peer-instances have fullfilled their objectives.
    if (seq > 5) end()
  })
})
```

```js
// myapp-scenario.js
const Simulator = require('hyper-simulator')

const sim = new Simulator({
  logger: line => console.error(JSON.stringify(line))
})

sim.on('tick', (iteration, summary) => {
  // launch more peers or something..
})

sim
  .setup([
    // Launch 20 peers behaving as leeches
    { name: 'leech', initFn: SimulatedPeer, count: 20 }

    // Launch 1 peer behaving as a seed
    { name: 'seed', initFn: SimulatedSeed, count: 1, maxConnections: 2 }
  ])
  // Run simulation 1x speed and 200ms delay between ticks
  .then(() => simulation.run(1, 200))
  .then(() => console.error('Simulation finished'))
  .catch(err => console.error('Simulation failed', err)
```

```bash
$ node myapp-scenario.js
```

## <a name="contribute"></a> Contributing

Ideas and contributions to the project are welcome. You must follow this [guideline](https://github.com/decentstack/hyper-simulator/blob/master/CONTRIBUTING.md).

## License

GNU AGPLv3 © Tony Ivanov
