/**
 * Easy Connection - Relay Server
 * 
 * Este servidor actúa como intermediario entre PCs que quieren conectarse.
 * Los PCs se registran con su código y el servidor los empareja.
 */

const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

// Almacén de sesiones activas: código -> { host: ws, client: ws }
const sessions = new Map();

// Almacén de conexiones esperando: código -> ws (el host esperando)
const waitingHosts = new Map();

const wss = new WebSocket.Server({ port: PORT });

console.log(`🚀 Easy Connection Relay Server corriendo en puerto ${PORT}`);

wss.on('connection', (ws) => {
    console.log('📱 Nueva conexión');
    
    ws.isAlive = true;
    ws.sessionCode = null;
    ws.role = null; // 'host' o 'client'
    
    ws.on('pong', () => {
        ws.isAlive = true;
    });
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            handleMessage(ws, message);
        } catch (e) {
            console.error('Error parsing message:', e);
        }
    });
    
    ws.on('close', () => {
        console.log('👋 Conexión cerrada');
        handleDisconnect(ws);
    });
    
    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
    });
});

function handleMessage(ws, message) {
    console.log('📨 Mensaje:', message.type);
    
    switch (message.type) {
        case 'register_host':
            handleRegisterHost(ws, message);
            break;
            
        case 'connect_to_host':
            handleConnectToHost(ws, message);
            break;
            
        case 'relay':
            handleRelay(ws, message);
            break;
            
        case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }));
            break;
            
        default:
            console.log('Mensaje desconocido:', message.type);
    }
}

function handleRegisterHost(ws, message) {
    const { code, device_id, device_name } = message;
    
    if (!code || code.length !== 9) {
        ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Código inválido' 
        }));
        return;
    }
    
    // Verificar si el código ya está en uso
    if (waitingHosts.has(code)) {
        ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Código ya en uso' 
        }));
        return;
    }
    
    // Registrar el host
    ws.sessionCode = code;
    ws.role = 'host';
    ws.deviceId = device_id;
    ws.deviceName = device_name;
    
    waitingHosts.set(code, ws);
    
    console.log(`🏠 Host registrado: ${device_name} con código ${code}`);
    
    ws.send(JSON.stringify({ 
        type: 'registered',
        code: code
    }));
}

function handleConnectToHost(ws, message) {
    const { code, device_id, device_name } = message;
    
    if (!code) {
        ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Código requerido' 
        }));
        return;
    }
    
    // Buscar el host
    const hostWs = waitingHosts.get(code);
    
    if (!hostWs || hostWs.readyState !== WebSocket.OPEN) {
        ws.send(JSON.stringify({ 
            type: 'connection_failed', 
            reason: 'No se encontró ningún PC con ese código. Verifica que:\n1. El código sea correcto\n2. El otro PC tenga el acceso activado'
        }));
        return;
    }
    
    // Crear la sesión
    ws.sessionCode = code;
    ws.role = 'client';
    ws.deviceId = device_id;
    ws.deviceName = device_name;
    
    sessions.set(code, {
        host: hostWs,
        client: ws
    });
    
    // Remover de waiting
    waitingHosts.delete(code);
    
    console.log(`🔗 Conexión establecida: ${device_name} -> ${hostWs.deviceName}`);
    
    // Notificar al host
    hostWs.send(JSON.stringify({
        type: 'peer_connected',
        peer_id: device_id,
        peer_name: device_name
    }));
    
    // Notificar al cliente
    ws.send(JSON.stringify({
        type: 'connected_to_host',
        host_id: hostWs.deviceId,
        host_name: hostWs.deviceName
    }));
}

function handleRelay(ws, message) {
    const session = sessions.get(ws.sessionCode);
    
    if (!session) {
        return;
    }
    
    // Determinar a quién enviar
    const target = ws.role === 'host' ? session.client : session.host;
    
    if (target && target.readyState === WebSocket.OPEN) {
        target.send(JSON.stringify({
            type: 'relayed',
            from: ws.role,
            data: message.data
        }));
    }
}

function handleDisconnect(ws) {
    if (!ws.sessionCode) return;
    
    const code = ws.sessionCode;
    
    // Si era un host esperando
    if (waitingHosts.get(code) === ws) {
        waitingHosts.delete(code);
        console.log(`🏠 Host desregistrado: ${code}`);
        return;
    }
    
    // Si estaba en una sesión activa
    const session = sessions.get(code);
    if (session) {
        const otherWs = ws.role === 'host' ? session.client : session.host;
        
        if (otherWs && otherWs.readyState === WebSocket.OPEN) {
            otherWs.send(JSON.stringify({
                type: 'peer_disconnected'
            }));
        }
        
        sessions.delete(code);
        console.log(`🔌 Sesión terminada: ${code}`);
    }
}

// Ping periódico para mantener conexiones vivas y limpiar muertas
const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) {
            console.log('💀 Conexión muerta, terminando');
            handleDisconnect(ws);
            return ws.terminate();
        }
        
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => {
    clearInterval(interval);
});

// Estadísticas
setInterval(() => {
    console.log(`📊 Stats: ${waitingHosts.size} hosts esperando, ${sessions.size} sesiones activas`);
}, 60000);
