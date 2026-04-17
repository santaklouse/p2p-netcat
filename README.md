# P2P Netcat based on libp2p

Decentralized netcat over libp2p: one stream using protocol `/p2p-netcat/1.0.0` between nodes and optional PubSub by topics. Works in both Node.js and browser.

## 🚀 Installation

### Via npm (recommended)

```bash
npm install p2p-netcat
```

### From source

Requires `Node.js >= 20`.

```bash
git clone https://github.com/yourusername/p2p-netcat.git
cd p2p-netcat
npm install
npm run build
```

Run from source (without build): `npx tsx src/index.ts ...`

## Netcat mode (stream)

1. On node **A** start the server (waits for incoming connection on protocol):

```bash
node dist/index.js --mode server
```

The `peerId` and `listen: ...` multiaddr will appear in stderr.

2. On node **B** connect to peer id of node A:

```bash
node dist/index.js --mode client --remote-peer-id <peer_id_of_node_A>
```

Nodes must see each other on the network (e.g., same LAN - **mDNS** enabled). Keyboard input goes to the stream; data from remote side is printed to stdout.

If the server peer is not yet up, you can enable waiting with retries:

```bash
node dist/index.js --mode client --remote-peer-id <peer_id_of_node_A> --wait --wait-timeout 120
```

Execute command over p2p stream (analog of `nc -e`):

```bash
node dist/index.js --mode server -e "bash -lc 'id; uname -a'"
```

Interactive login shell (analog of `gs-netcat -i`):

```bash
node dist/index.js --mode server -i
```

For interactive mode, escape `Ctrl-e q` is added to terminate the session.

## PubSub (topic)

Two or more processes with the same `--topic` exchange messages via PubSub:

```bash
node dist/index.js --topic chat
```

Publish from stdin:

```bash
echo "Hello" | node dist/index.js --topic chat
```

If mDNS doesn't provide stable discovery in your network/environment, connect peer explicitly:

```bash
node dist/index.js --topic chat --connect <multiaddr_of_other_peer>
```

## Architecture

- **libp2p** v3: TCP, WebSockets, Noise, mplex, identify, mDNS, FloodSub
- Data protocol: `/p2p-netcat/1.0.0` (duplex like netcat)

## Smoke tests

Quick check of basic functionality:

```bash
npm run smoke
```

Separately:

```bash
npm run smoke:netcat
npm run smoke:pubsub
```

## 📦 Usage as npm library

### Node.js

```javascript
import P2pNetcat from 'p2p-netcat'

// Create instance
const netcat = new P2pNetcat()

// Start node
await netcat.start()

// Get node information
console.log('Peer ID:', netcat.getPeerId())
console.log('Listen addresses:', netcat.getListenAddresses())

// Server mode
netcat.handleIncoming(async (session) => {
  console.log(`Incoming connection from ${session.peerId}`)
  
  // Read data from stream
  for await (const chunk of session.stream) {
    console.log('Received:', new TextDecoder().decode(chunk))
  }
})

// Client mode
const session = await netcat.dialPeer('12D3KooW...')
await session.stream.send(new TextEncoder().encode('Hello World!'))
```

### Browser

```javascript
import { BrowserP2pNetcat } from 'p2p-netcat/browser'

// Create instance with options
const netcat = new BrowserP2pNetcat({
  listen: ['/ip4/0.0.0.0/tcp/0/ws'],
  bootstrap: ['/ip4/127.0.0.1/tcp/4001/ws/p2p/12D3KooW...']
})

// Start node
await netcat.start()

// Netcat connection
netcat.handleIncoming(async (session) => {
  console.log(`Incoming connection from ${session.peerId}`)
  
  // Read messages
  for await (const data of netcat.readNetcat()) {
    console.log('Received:', new TextDecoder().decode(data))
  }
})

// Connect to remote node
const session = await netcat.dialNetcat('12D3KooW...')
await netcat.sendNetcat('Hello from browser!')

// PubSub
await netcat.subscribe('chat', (msg) => {
  console.log(`[${msg.topic}] ${new TextDecoder().decode(msg.data)}`)
})

await netcat.publish('chat', 'Hello from browser!')
```

### HTML example

```html
<!DOCTYPE html>
<html>
<head>
    <title>P2P Netcat Demo</title>
    <script type="module">
        import { BrowserP2pNetcat } from 'https://cdn.skypack.dev/p2p-netcat/browser'
        
        const netcat = new BrowserP2pNetcat()
        
        document.getElementById('start').onclick = async () => {
            await netcat.start()
            document.getElementById('peerId').textContent = netcat.getPeerId()
        }
        
        document.getElementById('send').onclick = async () => {
            const message = document.getElementById('message').value
            await netcat.sendNetcat(message)
        }
    </script>
</head>
<body>
    <button id="start">Start node</button>
    <div>Peer ID: <span id="peerId"></span></div>
    <input id="message" placeholder="Message">
    <button id="send">Send</button>
</body>
</html>
```

### React component example

```jsx
import React, { useState, useEffect } from 'react'
import { BrowserP2pNetcat } from 'p2p-netcat/browser'

function P2PChat() {
  const [netcat, setNetcat] = useState(null)
  const [messages, setMessages] = useState([])
  const [inputMessage, setInputMessage] = useState('')
  const [peerId, setPeerId] = useState('')
  const [status, setStatus] = useState('stopped')

  useEffect(() => {
    const init = async () => {
      const p2p = new BrowserP2pNetcat()
      await p2p.start()
      setPeerId(p2p.getPeerId())
      setNetcat(p2p)
      setStatus('started')
      
      // Subscribe to messages
      await p2p.subscribe('chat', (msg) => {
        setMessages(prev => [...prev, {
          from: msg.from,
          text: new TextDecoder().decode(msg.data),
          timestamp: new Date().toLocaleTimeString()
        }])
      })
    }
    
    init()
    
    return () => {
      if (netcat) {
        netcat.stop()
      }
    }
  }, [])

  const sendMessage = async () => {
    if (netcat && inputMessage.trim()) {
      await netcat.publish('chat', inputMessage)
      setInputMessage('')
    }
  }

  return (
    <div>
      <h3>P2P Chat</h3>
      <div>Peer ID: {peerId}</div>
      <div>Status: {status}</div>
      
      <div style={{ height: '300px', overflow: 'auto', border: '1px solid #ccc' }}>
        {messages.map((msg, i) => (
          <div key={i}>
            <strong>{msg.timestamp} {msg.from}:</strong> {msg.text}
          </div>
        ))}
      </div>
      
      <input
        value={inputMessage}
        onChange={(e) => setInputMessage(e.target.value)}
        onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
        placeholder="Enter message..."
      />
      <button onClick={sendMessage}>Send</button>
    </div>
  )
}
```

### Vue.js component example

```vue
<template>
  <div>
    <h3>P2P Chat</h3>
    <div>Peer ID: {{ peerId }}</div>
    <div>Status: {{ status }}</div>
    
    <div class="messages">
      <div v-for="(msg, i) in messages" :key="i">
        <strong>{{ msg.timestamp }} {{ msg.from }}:</strong> {{ msg.text }}
      </div>
    </div>
    
    <div class="input">
      <input 
        v-model="inputMessage" 
        @keypress.enter="sendMessage"
        placeholder="Enter message..."
      />
      <button @click="sendMessage">Send</button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { BrowserP2pNetcat } from 'p2p-netcat/browser'

const netcat = ref(null)
const messages = ref([])
const inputMessage = ref('')
const peerId = ref('')
const status = ref('stopped')

onMounted(async () => {
  netcat.value = new BrowserP2pNetcat()
  await netcat.value.start()
  peerId.value = netcat.value.getPeerId()
  status.value = 'started'
  
  await netcat.value.subscribe('chat', (msg) => {
    messages.value.push({
      from: msg.from,
      text: new TextDecoder().decode(msg.data),
      timestamp: new Date().toLocaleTimeString()
    })
  })
})

onUnmounted(() => {
  if (netcat.value) {
    netcat.value.stop()
  }
})

const sendMessage = async () => {
  if (netcat.value && inputMessage.value.trim()) {
    await netcat.value.publish('chat', inputMessage.value)
    inputMessage.value = ''
  }
}
</script>
```

## 🔧 API Reference

### BrowserP2pNetcat

#### Constructor

```typescript
new BrowserP2pNetcat(options?: BrowserNetcatOptions)
```

**Options:**
- `listen?: string[]` - Addresses to listen on (default: `['/ip4/0.0.0.0/tcp/0/ws']`)
- `bootstrap?: string[]` - Bootstrap peers to connect to

#### Methods

- `start(): Promise<void>` - Start node
- `stop(): Promise<void>` - Stop node
- `getPeerId(): string` - Get node ID
- `getListenAddresses(): string[]` - Get listen addresses
- `connect(address: string): Promise<void>` - Connect to peer
- `handleIncoming(onSession: Function): void` - Handle incoming connections
- `dialNetcat(remotePeerId: string): Promise<NetcatSession>` - Establish netcat connection
- `sendNetcat(data: string | Uint8Array): Promise<void>` - Send data
- `readNetcat(): AsyncGenerator<Uint8Array>` - Read data from stream
- `subscribe(topic: string, onMessage: Function): Promise<Function>` - Subscribe to PubSub topic
- `publish(topic: string, data: string | Uint8Array): Promise<void>` - Publish message
- `getSubscriberCount(topic: string): number` - Get subscriber count
- `isStarted(): boolean` - Check if node is started
- `getActiveSession(): NetcatSession | null` - Get active session
- `closeSession(): Promise<void>` - Close active session

## 🌐 Demo

Open `demo.html` in browser for interactive demonstration of library capabilities.

```bash
npm run demo
```

## License

MIT
