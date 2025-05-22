import 'dotenv/config'
import TelegramBot from 'node-telegram-bot-api'
import { GoogleGenAI } from '@google/genai'

const DEBUG = process.argv.includes('--debug')

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true })
const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY })

const userQuestions = new Map()

bot.on('polling_error', (error) => {
  console.error('Polling error:', error)
})

bot.onText(/\/start|\/help/, (msg) => {
  if (DEBUG) console.log(`User ${msg.from.id} sent /start or /help`)
  bot.sendMessage(msg.chat.id, 'Selamat Datang! Silakan tanyakan apa saja dengan memulai pesan Anda dengan "/tanya pertanyaan".')
})

bot.onText(/\/tanya (.+)/, async (msg, match) => {
  const userId = msg.from.id
  const question = match[1].trim()

  if (DEBUG) console.log(`Received question from user ${userId}: ${question}`)

  if (question.split(' ').length <= 1) {
    if (DEBUG) console.log('Question too short')
    return bot.sendMessage(msg.chat.id, 'Pertanyaan Anda terlalu pendek. Harap berikan pertanyaan yang lebih jelas dan lengkap.')
  }

  userQuestions.set(userId, [question])

  try {
    if (DEBUG) console.log('Calling Google Gemini API...')
    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: [{ role: 'user', parts: [{ text: question }] }]
    })

    const answer = response.candidates?.[0]?.content?.parts?.[0]?.text || 'Maaf, tidak ada jawaban.'
    if (DEBUG) console.log('AI response:', answer)

    bot.sendMessage(msg.chat.id, answer)
  } catch (error) {
    console.error('Error from AI:', error)
    bot.sendMessage(msg.chat.id, 'Maaf, terjadi kesalahan saat memproses pertanyaan Anda.')
  }
})

bot.on('message', async (msg) => {
  if (!msg.text || !msg.reply_to_message || msg.reply_to_message.from.id !== bot.botInfo.id) return

  const userId = msg.from.id
  const prevQuestions = userQuestions.get(userId) || []
  const combinedQuestion = (msg.reply_to_message.text + ' ' + msg.text).trim()

  if (DEBUG) console.log(`User ${userId} replied with combined question: ${combinedQuestion}`)

  if (combinedQuestion.split(' ').length <= 1) {
    if (DEBUG) console.log('Combined question too short')
    return bot.sendMessage(msg.chat.id, 'Pertanyaan Anda terlalu pendek. Harap berikan pertanyaan yang lebih jelas dan lengkap.')
  }

  prevQuestions.push(combinedQuestion)
  userQuestions.set(userId, prevQuestions)

  try {
    if (DEBUG) console.log('Calling Google Gemini API...')
    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: [{ role: 'user', parts: [{ text: combinedQuestion }] }]
    })

    const answer = response.candidates?.[0]?.content?.parts?.[0]?.text || 'Maaf, tidak ada jawaban.'
    if (DEBUG) console.log('AI response:', answer)

    bot.sendMessage(msg.chat.id, answer)
  } catch (error) {
    console.error('Error from AI:', error)
    bot.sendMessage(msg.chat.id, 'Maaf, terjadi kesalahan saat memproses pertanyaan Anda.')
  }
})

bot.getMe().then((botInfo) => {
  bot.botInfo = botInfo
  console.log(`Bot is running as @${botInfo.username}`)
}).catch((err) => {
  console.error('Failed to get bot info:', err)
})
