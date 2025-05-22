import 'dotenv/config'
import TelegramBot from 'node-telegram-bot-api'
import { GoogleGenAI } from '@google/genai'
import fs from 'fs/promises'

const DEBUG = process.argv.includes('--debug')

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true })
const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY })

const userQuestions = new Map()

async function readPersona() {
  try {
    const content = await fs.readFile('./persona.txt', 'utf-8')
    const trimmed = content.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
}

async function buildContentText(question) {
  const persona = await readPersona()
  if (persona) {
    return `${persona}\n\n---\n\n${question}`
  }
  return question
}

async function handleQuestion(msg, question) {
  const userId = msg.from.id
  userQuestions.set(userId, [question])

  if (DEBUG) console.log(`User ${userId} asked: ${question}`)

  try {
    const fullText = await buildContentText(question)

    if (DEBUG) console.log('Full content sent to AI:', fullText)

    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: [{ role: 'user', parts: [{ text: fullText }] }],
    })

    const answer = response.candidates?.[0]?.content?.parts?.map(p => p.text).join(' ') || 'Maaf, tidak ada jawaban.'
    bot.sendMessage(msg.chat.id, answer)
  } catch (error) {
    console.error('Error from AI:', error)
    bot.sendMessage(msg.chat.id, 'Maaf, terjadi kesalahan saat memproses pertanyaan Anda.')
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
    return bot.sendMessage(msg.chat.id, 'Pertanyaan Anda terlalu pendek. Harap berikan pertanyaan yang lebih lengkap.')
  }
  await handleQuestion(msg, question)
})

bot.on('message', async (msg) => {
  if (!msg.text || !msg.reply_to_message || msg.reply_to_message.from.id !== bot.botInfo.id) return

  const userId = msg.from.id
  const prev = userQuestions.get(userId) || []
  const combined = `${msg.reply_to_message.text} ${msg.text}`.trim()

  if (combined.split(' ').length <= 1) {
    return bot.sendMessage(msg.chat.id, 'Pertanyaan Anda terlalu pendek. Harap berikan pertanyaan yang lebih lengkap.')
  }

  prev.push(combined)
  userQuestions.set(userId, prev)
  await handleQuestion(msg, combined)
})

bot.getMe().then((info) => {
  bot.botInfo = info
  console.log(`Bot is running as @${info.username}`)
}).catch((err) => {
  console.error('Failed to get bot info:', err)
})
