# P2P Netcat на базе libp2p

Децентрализованный netcat поверх libp2p: один поток по протоколу `/p2p-netcat/1.0.0` между узлами и опциональный PubSub по темам. Работает как в Node.js, так и в браузере.

## 🚀 Установка

### Через npm (рекомендуется)

```bash
npm install p2p-netcat
```

### Из исходников

Требуется `Node.js >= 20`.

```bash
git clone https://github.com/yourusername/p2p-netcat.git
cd p2p-netcat
npm install
npm run build
```

Запуск из исходников (без сборки): `npx tsx src/index.ts ...`

## Режим netcat (stream)

1. На узле **A** запустите сервер (ждёт входящее соединение по протоколу):

```bash
node dist/index.js --mode server
```

В stderr появятся `peerId` и `listen: ...` multiaddr.

2. На узле **B** подключитесь к peer id узла A:

```bash
node dist/index.js --mode client --remote-peer-id <peer_id_узла_A>
```

Узлы должны видеть друг друга в сети (например одна LAN — включён **mDNS**). Ввод с клавиатуры уходит в поток; данные с удалённой стороны печатаются в stdout.

Если серверный peer ещё не поднят, можно включить ожидание с ретраями:

```bash
node dist/index.js --mode client --remote-peer-id <peer_id_узла_A> --wait --wait-timeout 120
```

Выполнение команды поверх p2p-потока (аналог `nc -e`):

```bash
node dist/index.js --mode server -e "bash -lc 'id; uname -a'"
```

Интерактивный login shell (аналог `gs-netcat -i`):

```bash
node dist/index.js --mode server -i
```

Для интерактивного режима добавлен escape `Ctrl-e q` для завершения сессии.

## PubSub (тема)

Два и более процесса с одной и той же `--topic` обмениваются сообщениями через PubSub:

```bash
node dist/index.js --topic chat
```

Публикация из stdin:

```bash
echo "Hello" | node dist/index.js --topic chat
```

Если mDNS не даёт стабильного discovery в вашей сети/среде, подключайте пир явно:

```bash
node dist/index.js --topic chat --connect <multiaddr_другого_пира>
```

## Архитектура

- **libp2p** v3: TCP, WebSockets, Noise, mplex, identify, mDNS, FloodSub
- Протокол данных: `/p2p-netcat/1.0.0` (дуплекс как у netcat)

## Smoke тесты

Быстрая проверка базовой работоспособности:

```bash
npm run smoke
```

Отдельно:

```bash
npm run smoke:netcat
npm run smoke:pubsub
```

## 📦 Использование как npm библиотеки

### Node.js

```javascript
import P2pNetcat from 'p2p-netcat'

// Создание экземпляра
const netcat = new P2pNetcat()

// Запуск узла
await netcat.start()

// Получение информации об узле
console.log('Peer ID:', netcat.getPeerId())
console.log('Listen addresses:', netcat.getListenAddresses())

// Режим сервера
netcat.handleIncoming(async (session) => {
  console.log(`Входящее соединение от ${session.peerId}`)
  
  // Чтение данных из потока
  for await (const chunk of session.stream) {
    console.log('Получено:', new TextDecoder().decode(chunk))
  }
})

// Режим клиента
const session = await netcat.dialPeer('12D3KooW...')
await session.stream.send(new TextEncoder().encode('Hello World!'))
```

### Браузер

```javascript
import { BrowserP2pNetcat } from 'p2p-netcat/browser'

// Создание экземпляра с опциями
const netcat = new BrowserP2pNetcat({
  listen: ['/ip4/0.0.0.0/tcp/0/ws'],
  bootstrap: ['/ip4/127.0.0.1/tcp/4001/ws/p2p/12D3KooW...']
})

// Запуск узла
await netcat.start()

// Netcat соединение
netcat.handleIncoming(async (session) => {
  console.log(`Входящее соединение от ${session.peerId}`)
  
  // Чтение сообщений
  for await (const data of netcat.readNetcat()) {
    console.log('Получено:', new TextDecoder().decode(data))
  }
})

// Подключение к удаленному узлу
const session = await netcat.dialNetcat('12D3KooW...')
await netcat.sendNetcat('Hello from browser!')

// PubSub
await netcat.subscribe('chat', (msg) => {
  console.log(`[${msg.topic}] ${new TextDecoder().decode(msg.data)}`)
})

await netcat.publish('chat', 'Привет из браузера!')
```

### HTML пример

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
    <button id="start">Запустить узел</button>
    <div>Peer ID: <span id="peerId"></span></div>
    <input id="message" placeholder="Сообщение">
    <button id="send">Отправить</button>
</body>
</html>
```

### React компонент пример

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
      
      // Подписка на сообщения
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
        placeholder="Введите сообщение..."
      />
      <button onClick={sendMessage}>Отправить</button>
    </div>
  )
}
```

### Vue.js компонент пример

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
        placeholder="Введите сообщение..."
      />
      <button @click="sendMessage">Отправить</button>
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

#### Конструктор

```typescript
new BrowserP2pNetcat(options?: BrowserNetcatOptions)
```

**Options:**
- `listen?: string[]` - Адреса для прослушивания (по умолчанию: `['/ip4/0.0.0.0/tcp/0/ws']`)
- `bootstrap?: string[]` - Bootstrap пиры для подключения

#### Методы

- `start(): Promise<void>` - Запустить узел
- `stop(): Promise<void>` - Остановить узел
- `getPeerId(): string` - Получить ID узла
- `getListenAddresses(): string[]` - Получить адреса прослушивания
- `connect(address: string): Promise<void>` - Подключиться к пиру
- `handleIncoming(onSession: Function): void` - Обрабатывать входящие соединения
- `dialNetcat(remotePeerId: string): Promise<NetcatSession>` - Установить netcat соединение
- `sendNetcat(data: string | Uint8Array): Promise<void>` - Отправить данные
- `readNetcat(): AsyncGenerator<Uint8Array>` - Читать данные из потока
- `subscribe(topic: string, onMessage: Function): Promise<Function>` - Подписаться на PubSub тему
- `publish(topic: string, data: string | Uint8Array): Promise<void>` - Опубликовать сообщение
- `getSubscriberCount(topic: string): number` - Получить количество подписчиков
- `isStarted(): boolean` - Проверить запущен ли узел
- `getActiveSession(): NetcatSession | null` - Получить активную сессию
- `closeSession(): Promise<void>` - Закрыть активную сессию

## 🌐 Демо

Откройте `demo.html` в браузере для интерактивной демонстрации возможностей библиотеки.

```bash
npm run demo
```

## Лицензия

MIT
