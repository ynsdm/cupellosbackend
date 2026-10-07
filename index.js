import express from 'express';
import axios from 'axios';
import OpenAI from 'openai';
import { createClient } from 'redis';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ===================================================================
// 1. INICIALIZAR CLIENTE DE REDIS CLOUD
// ===================================================================
const redisClient = createClient({
  url: process.env.REDIS_URL,
});

redisClient.on('error', (err) => console.error('Error en Redis Cloud:', err));

await redisClient.connect();
console.log('✅ Conectado exitosamente a Redis Cloud.');

// ===================================================================
// 2. INICIALIZAR CLIENTE DE OPENAI
// ===================================================================
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ===================================================================
// 3. FUNCIONES PARA EL HISTORIAL DE CONVERSACIÓN (REDIS)
// ===================================================================
async function getHistory(phone) {
  try {
    const data = await redisClient.get(`chat:${phone}`);
    return data ? JSON.parse(data) : [];
  } catch (error) {
    console.error('Error leyendo historial:', error);
    return [];
  }
}

async function saveHistory(phone, history) {
  try {
    // Guarda el historial y expira automáticamente tras 24 horas (86400 segundos)
    await redisClient.set(`chat:${phone}`, JSON.stringify(history), {
      EX: 86400,
    });
  } catch (error) {
    console.error('Error guardando historial:', error);
  }
}

// ===================================================================
// 4. GENERACIÓN DE RESPUESTAS CON OPENAI Y CONTEXTO
// ===================================================================
async function generateAIResponse(phone, userMessage) {
  // Obtener historial existente del cliente
  let history = await getHistory(phone);

  // Agregar mensaje del usuario al historial
  history.push({ role: 'user', content: userMessage });

  // Limitar a los últimos 10 mensajes para ahorrar tokens
  if (history.length > 10) {
    history = history.slice(-10);
  }

  // Prompt del sistema adaptado para Cupello Joyas
  const systemPrompt = {
    role: 'system',
    content: `Eres el asistente virtual oficial de Cupello Joyas, una marca exclusiva de joyería de alta gama.
Tu objetivo es atender a los clientes con un tono elegante, atento, exclusivo y muy profesional.
Responde de forma clara, directa y en un máximo de 2 párrafos cortos por mensaje.
Si te preguntan por productos específicos, ofrece ayuda para coordinar una cita o mostrar piezas del catálogo.`
  };

  const messages = [systemPrompt, ...history];

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: messages,
    max_tokens: 300,
  });

  const aiReply = completion.choices[0].message.content.trim();

  // Guardar la respuesta de la IA en el historial
  history.push({ role: 'assistant', content: aiReply });
  await saveHistory(phone, history);

  return aiReply;
}

// ===================================================================
// 5. ENVÍO DE MENSAJES VÍA WHATSAPP CLOUD API
// ===================================================================
async function sendWhatsAppMessage(to, text) {
  const url = `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  await axios.post(
    url,
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: 'text',
      text: { body: text },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );
}

// ===================================================================
// 6. ENDPOINT GET (VERIFICACIÓN DEL WEBHOOK POR META)
// ===================================================================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
      console.log('✅ Webhook verificado correctamente por Meta.');
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }
  res.sendStatus(400);
});

// ===================================================================
// 7. ENDPOINT POST (RECEPCIÓN DE MENSAJES DE WHATSAPP)
// ===================================================================
app.post('/webhook', async (req, res) => {
  // Confirmar recepción a Meta inmediatamente para evitar reintentos
  res.status(200).send('EVENT_RECEIVED');

  const body = req.body;

  if (body.object === 'whatsapp_business_account') {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    // Procesar únicamente mensajes de texto entrantes
    if (message && message.type === 'text') {
      const fromNumber = message.from;
      const userMessage = message.text.body;

      console.log(`📩 Mensaje de ${fromNumber}: "${userMessage}"`);

      try {
        const responseText = await generateAIResponse(fromNumber, userMessage);
        await sendWhatsAppMessage(fromNumber, responseText);
        console.log(`📤 Respuesta enviada a ${fromNumber}`);
      } catch (error) {
        console.error('Error procesando el mensaje:', error.response?.data || error.message);
      }
    }
  }
});

// ===================================================================
// 8. INICIAR SERVIDOR
// ===================================================================
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
});
