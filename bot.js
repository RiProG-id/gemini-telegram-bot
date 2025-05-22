import 'dotenv/config'
import TelegramBot from 'node-telegram-bot-api'
import { GoogleGenAI } from '@google/genai'
import fs from 'fs/promises'

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true })
const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY })

const userConversations = new Map()

async function readPersona() {
  try {
    const content = await fs.readFile('./persona.txt', 'utf-8')
    const trimmed = content.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
}

async function buildContentText(persona, replyText, question) {
  let combined = ''
  if (persona) combined += persona + '\n\n---\n\n'
  if (replyText) combined += replyText + '\n\n'
  combined += question
  return combined
}

async function handleQuestion(msg, question, replyText = '') {
  const persona = await readPersona()
  const content = await buildContentText(persona, replyText, question)

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: [{ role: 'user', parts: [{ text: content }] }],
    })

    const answer = response.candidates?.[0]?.content?.parts?.map(p => p.text).join(' ') || 'Maaf, tidak ada jawaban.'
    await bot.sendMessage(msg.chat.id, answer, { reply_to_message_id: msg.message_id })
  } catch (error) {
    console.error('Error from AI:', error)
    await bot.sendMessage(msg.chat.id, 'Maaf, terjadi kesalahan saat memproses pertanyaan Anda.', { reply_to_message_id: msg.message_id })
  }
}

bot.on('polling_error', (error) => {
  console.error('Polling error:', error)
})

bot.onText(/\/start|\/help/, (msg) => {
  const message = `
Author: @RiProG
Channel: @RiOpSo
Group: @RiOpSoDisc

Support me: https://t.me/RiOpSo/2848

Gunakan perintah:
/tanya [pertanyaan Anda]
  `.trim()

  bot.sendMessage(msg.chat.id, message)
})

bot.onText(/\/tanya (.+)/, async (msg, match) => {
  const question = match[1].trim()
  if (question.split(' ').length <= 1) {
    return bot.sendMessage(msg.chat.id, 'Pertanyaan Anda terlalu pendek. Harap berikan pertanyaan yang lebih lengkap.', { reply_to_message_id: msg.message_id })
  }

  const chatType = msg.chat.type

  if (chatType === 'private') {
    const conv = userConversations.get(msg.from.id) || []
    const replyText = conv.length > 0 ? conv[conv.length - 1] : ''
    userConversations.set(msg.from.id, [question])

    await handleQuestion(msg, question, replyText)

  } else if (chatType === 'group' || chatType === 'supergroup') {
    if (msg.reply_to_message) {
      if (msg.reply_to_message.from.id === bot.botInfo.id) {
        const replyText = msg.reply_to_message.text || ''
        await handleQuestion(msg, question, replyText)
      }
    } else {
      await handleQuestion(msg, question, '')
    }
  }
})

bot.on('message', async (msg) => {
  if (!msg.text) return

  const chatType = msg.chat.type
  const userId = msg.from.id

  if (chatType === 'private') {
    if (msg.text.startsWith('/start') || msg.text.startsWith('/help') || msg.text.startsWith('/tanya ')) return

    const text = msg.text.trim()
    if (text.split(' ').length <= 1) {
      return bot.sendMessage(msg.chat.id, 'Pertanyaan Anda terlalu pendek. Harap berikan pertanyaan yang lebih lengkap.', { reply_to_message_id: msg.message_id })
    }

    const conv = userConversations.get(userId) || []
    const replyText = conv.length > 0 ? conv[conv.length - 1] : ''
    userConversations.set(userId, [text])

    await handleQuestion(msg, text, replyText)
  }
})

bot.getMe().then(info => {
  bot.botInfo = info
  console.log(`Bot is running as @${info.username}`)
}).catch(err => {
  console.error('Failed to get bot info:', err)
})
