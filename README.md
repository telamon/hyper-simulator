# hyper-simulator

[![Build Status](https://travis-ci.org/decentstack/hyper-simulator.svg?branch=master)](https://travis-ci.org/decentstack/hyper-simulator)
[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)

> Simulate a swarm of peers running hyperswarm compatible applications

The simulation generates a detailed "swarm-log" in `ndjson` format that can be used to analyze your applications
behaviour over time.

The screencast below demonstrates the built-in terminal-aggregator view that
shows the simulator's status in real-time! Further offline analysis can be done anyway you want, heres
a couple of related projects:

- [hypersim-parser](https://github.com/decentstack/hypersim-parser) Fast and memory efficient ndjson aggregator.
- [hypersim-visualizer](https://github.com/decentstack/hypersim-visualizer) fancy Vue+D3.js visualizer.

[![asciicast](https://asciinema.org/a/292041.svg)](https://asciinema.org/a/292041)

TODO:

- [x] Refactor behaviour registration interface
- [x] Let executable output minimal aggregation during runtime.
- [x] Release `hypersim-parser`
- [x] Provide hyperswarm interface
- [ ] Release `hypersim-visualizer`
- [ ] Support real hyperswarm with simulated network stack?

## <a name="install"></a> Install

```bash
# with npm
npm i --save-dev hyper-simulator

# or with yarn
yarn add -D hyper-simulator

```

## <a name="usage"></a> Usage

Running from commandline:

```bash
$(npm bin)/hypersim -T scenarios/myapp-scenario.js
```

### Defining a Scenario

Example scenario:
```js
const Simulator = require('hyper-simulator')

const sim = new Simulator()

await sim.ready() // Give the simulator some time to initialize

function MySeedSpawner() {
  // See peer-factory docs below.
}

function MyLeechSpawner() {
  // See peer-factory docs below.
}

// Launch 1 slow seed
sim.launch('seed',{ linkRate: 56<<8 }, MySeedSpawner())

// Launch 10 peers
for (let i = 0; i < 10; i++) {
  sim.launch('peer', MyLeechSpawner())
}

// Run simulation 1x speed and 200ms delay between ticks.
sim.run(1, 200)
  .then(() => console.error('Simulation finished'))
  .catch(err => console.error('Simulation failed', err)

// Simulator will run until manually stopped or all peers have signaled that they're done.
```

### Peer factory function

The launch interface is defined as followed:

#### `simulator.launch([name], [opts], initFn)`

- _optional_ **name** `String` tag the peer with a name or descriptor.
- _optional_ **opts** `Object` Launch options se below for defaults
- **intFn** `function(simContext, peerDone)` Peer factory function, see below
- **return** the result of `initFn` invocation.

Example opts:
```js
{
  name: 'anon',       // Tag peer with a name.
  linkRate: 102400,   // Maximum bandwidth in Bytes/Second
  maxConnections: 3,  // Maximum amount of active connections to maintain.
}
```

Example peer factory function:

```js
function SpawnPeer(context, peerDone) {
  // Destructure all values in context
  const {
    id,      // Uniquely generated id
    name,    // Name of peer as specified by launch()
    storage, // An instance of random-access-file,
    swarm,   // An instance of simulated hyperswarm
    opts,    // Copy of opts given to launch()
    signal,  // Function signal(eventName, payload) (more on this below)
    ontick,  // Lets you register a handler for peer.tick event: ontick(myHandlerFun)
    simulator // reference to the simulator.
  } = context

  // Initialize a decentralized feed or your application.
  const feed = hypercore(storage)

  // Find peers to replicate with
  feed.onReady(() => {
    // Handle remote connections
    swarm.on('connection', (socket, { client }) => {
      socket
        .pipe(feed.replicate(client, { live: true }))
        .pipe(socket)
    })

    // Join the topic
    swarm.join(feed.key)
  })

  // Add custom signaling to the simulator output
  feed.on('download', seq => {
    signal('download', { seq })
  })

  // Attach peer.tick handler
  ontick(summary => {
    // Signal done when this peer has more than 5 blocks downloaded.
    if (feed.downloaded() > 5) peerDone()

    // Decorate the simulator peer#tick output with extra keys/values
    return { downloadedBlocks: feed.downloaded() }
  })
}

```

## Swarm-log

The following built-in events that are logged,

**Global keys**

All events will contain the following keys:

- **iteration** `{Number}` number of simulator ticks since start.
- **sessionId** `{Number}` Time/date at simulator initialization.
- **type** `{String}` Type of event
- **event** `{String}` Name of event
- **time** `{Number}` Amount of virtual milliseconds since simulator start.

#### simulator `state-initializing`

Emitted when simulator is instantiated

- **type** `simulator`
- **event** `state-initializing`
- **swarm** `hypersim|hyperswarm`


#### simulator `state-ready`

Emitted when simulator becomes ready

- **type** `simulator`
- **event** `state-ready`
- **swarm** `hypersim|hyperswarm`

#### simulator `state-running`
Emitted when simulator is started.
- **type** `simulator`
- **event** `state-running`
- **speed** `{number}` desc
- **interval** `{number}` desc

#### simulator `tick`

Emitted once on each tick

- **type** `simulator`
- **event** `tick`
- **state** `{string}` current state
- **delta** `{number}` virtual amount of milliseconds since previous tick.
- **pending** `{number}` Amount of non-finished peers in simulation.
- **connections** `{number}` Total amount of connections in swarm.
- **peers** `{number}` Amount of peers in swarm
- **capacity** `{number}` Sum of all peers' bandwidth
- **rate** `{number}` Sum of all peers' reported rate
- **load** `{number}` rate / capacity

#### simulator `state-finished`

Emitted once when all active peers have reached the 'done' or exited with an error.

- **type** `simulator`
- **event** `state-finished`


#### peer `init`

Emitted when a peer is launched

- **type** `peer`
- **event** `init`
- **id** `{number}` unique id of the peer.
- **name** `{string}` Peer name as provided during launch


#### peer `end`

Emitted when a peer has signaled being done or has thrown
an uncaught error.

- **type** `peer`
- **event** `end`
- **id** `{number}` unique id of the peer.
- **name** `{string}` Peer name as provided during launch
- **error** `{object}` null or the error that caused the peer to exit.

#### peer `tick`

Emitted by each peer every simulator tick.

- **type** `peer`
- **event** `tick`
- **id** `{number}` Unique peer id.
- **name** `{string}` Peer name
- **rx** `{number}` Number of bytes received during tick
- **tx** `{number}` Number of bytes transfered during tick
- **maxConnections** `{number}` Connection limit.
- **connectionCount** `{number}` Current connection count.
- **linkRate** `{number}` Bandwidth limit of peer.
- **load** `{number}` Bandwidth used during tick.
- **state** `{string}` State of peer. `active` or `done`
- **age** `{number}` Amount of ticks lived
- **finished** `{boolean}` true when peer signaled being done/ended.

#### socket `tick`

Emitted on each tick for each active connection in simulation.

- **type** `socket`
- **event** `tick`
- **rx** `{number}` Number of bytes received during tick
- **tx** `{number}` Number of bytes transfered during tick
- **noop** `{boolean}` true if no traffic occured during this tick
- **rxEnd** `{boolean}` receving end of socket is closed
- **txEnd** `{boolean}` transmitting end of socket is closed
- **rxDrained** `{boolean}` Receiving buffer not empty
- **txDrained** `{boolean}` Transmitting buffer not empty
- **id** `{string}` Unique id of socket
- **src** `{number}` Source peer id
- **dst** `{number}` Destination peer id
- **load** `{number}` (rx + tx) / Math.min(srcPeer.linkRate, dstPeer.linkRate)

#### custom

Emitted using the `signal` method provided by the peer launch interface.

- **type** `custom`
- **event** `{string}` The event name as signaled by application.
- **name** `{string}` Peer name that emitted the event
- **id** `{number}` Id of peer that emitted the event
- `YOUR CUSTOM METRICS`

## <a name="contribute"></a> Contributing

Ideas and contributions to the project are welcome. You must follow this [guideline](https://github.com/decentstack/hyper-simulator/blob/master/CONTRIBUTING.md).

## License

GNU AGPLv3 © Tony Ivanov

