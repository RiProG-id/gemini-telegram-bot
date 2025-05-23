import 'dotenv/config'
import TelegramBot from 'node-telegram-bot-api'
import { GoogleGenAI, Modality } from '@google/genai'
import fs from 'fs/promises'
import * as fsSync from 'node:fs'

let fetchFn
try {
  fetchFn = fetch
} catch {
  fetchFn = (await import('node-fetch')).then(mod => mod.default)
}

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

    await bot.sendMessage(msg.chat.id, answer, {
      reply_to_message_id: msg.message_id,
    })
  } catch (error) {
    console.error('Error from AI:', error)
    await bot.sendMessage(msg.chat.id, 'Maaf, terjadi kesalahan saat memproses pertanyaan Anda.', {
      reply_to_message_id: msg.message_id,
    })
  }
}

async function handleImageRequest(msg, prompt) {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash-preview-image-generation',
      contents: [{ text: prompt }],
      config: { responseModalities: [Modality.TEXT, Modality.IMAGE] },
    })

    let imageSent = false
    for (const part of response.candidates[0].content.parts) {
      if (part.text) {
        await bot.sendMessage(msg.chat.id, part.text, {
          reply_to_message_id: msg.message_id,
        })
      } else if (part.inlineData) {
        const imageData = part.inlineData.data
        const buffer = Buffer.from(imageData, 'base64')
        const fileName = `image_${msg.message_id}.png`
        fsSync.writeFileSync(fileName, buffer)
        await bot.sendPhoto(msg.chat.id, fileName, {
          reply_to_message_id: msg.message_id,
        })
        fsSync.unlinkSync(fileName)
        imageSent = true
      }
    }

    if (!imageSent) {
      await bot.sendMessage(msg.chat.id, 'Maaf, tidak dapat membuat gambar.', {
        reply_to_message_id: msg.message_id,
      })
    }
  } catch (error) {
    console.error('Error generating image:', error)
    await bot.sendMessage(msg.chat.id, 'Terjadi kesalahan saat membuat gambar.', {
      reply_to_message_id: msg.message_id,
    })
  }
}

async function handleImageEditFromMessage(msg, captionPrompt) {
  let photo = null

  if (
    msg.reply_to_message?.from?.id === bot.botInfo.id &&
    (msg.reply_to_message.photo || msg.reply_to_message.document?.mime_type?.startsWith('image/'))
  ) {
    photo = msg.reply_to_message.photo?.at(-1)
  } else {
    photo = msg.photo?.at(-1) || msg.reply_to_message?.photo?.at(-1)
  }

  if (!photo) return

  try {
    const fileLink = await bot.getFileLink(photo.file_id)
    const res = await fetchFn(fileLink)
    const buffer = await res.arrayBuffer()
    const base64Image = Buffer.from(buffer).toString('base64')

    const promptText = captionPrompt?.trim()
    if (!promptText) {
      return bot.sendMessage(msg.chat.id, 'Deskripsi gambar tidak boleh kosong.', {
        reply_to_message_id: msg.message_id,
      })
    }

    const contents = [
      { text: promptText },
      {
        inlineData: {
          mimeType: 'image/jpeg',
          data: base64Image,
        },
      },
    ]

    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash-preview-image-generation',
      contents,
      config: { responseModalities: [Modality.TEXT, Modality.IMAGE] },
    })

    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.text) {
        await bot.sendMessage(msg.chat.id, part.text, {
          reply_to_message_id: msg.message_id,
        })
      } else if (part.inlineData) {
        const imageData = part.inlineData.data
        const buffer = Buffer.from(imageData, 'base64')
        const fileName = `image_edit_${msg.message_id}.png`
        fsSync.writeFileSync(fileName, buffer)
        await bot.sendPhoto(msg.chat.id, fileName, {
          reply_to_message_id: msg.message_id,
        })
        fsSync.unlinkSync(fileName)
      }
    }
  } catch (err) {
    console.error('Error editing image:', err)
    await bot.sendMessage(msg.chat.id, 'Terjadi kesalahan saat memproses gambar.', {
      reply_to_message_id: msg.message_id,
    })
  }
}

bot.on('polling_error', error => {
  console.error('Polling error:', error)
})

bot.onText(/(start|help)/, msg => {
  const message = `Author: @RiProG
Channel: @RiOpSo
Group: @RiOpSoDisc

Support me: https://t.me/RiOpSo/2848

Source Code: https://github.com/RiProG-id/gemini-telegram-bot

Gunakan perintah:
/tanya [pertanyaan Anda]
/gambar [deskripsi gambar]`
  bot.sendMessage(msg.chat.id, message)
})

bot.onText(/tanya (.+)/, async (msg, match) => {
  const question = match[1].trim()
  if (question.split(' ').length <= 1) {
    return bot.sendMessage(msg.chat.id, 'Pertanyaan Anda terlalu pendek. Harap berikan pertanyaan yang lebih lengkap.', {
      reply_to_message_id: msg.message_id,
    })
  }
  const replyText = msg.reply_to_message?.text || ''
  return await handleQuestion(msg, question, replyText)
})

bot.onText(/gambar (.+)/, async (msg, match) => {
  const prompt = match[1].trim()
  if (prompt.length === 0) {
    return bot.sendMessage(msg.chat.id, 'Deskripsi gambar tidak boleh kosong.', {
      reply_to_message_id: msg.message_id,
    })
  }

  if (msg.reply_to_message?.photo || msg.photo) return

  await handleImageRequest(msg, prompt)
})

bot.on('message', async msg => {
  const chatType = msg.chat.type
  const text = msg.text?.trim() || ''
  const captionPrompt = msg.caption?.trim() || ''

  if (chatType === 'private' && (msg.photo || msg.reply_to_message?.photo)) {
    if (!captionPrompt) {
      return bot.sendMessage(msg.chat.id, 'Deskripsi gambar tidak boleh kosong.', {
        reply_to_message_id: msg.message_id,
      })
    }
    return await handleImageEditFromMessage(msg, captionPrompt)
  }

  if (
    msg.reply_to_message?.from?.id === bot.botInfo.id &&
    (msg.reply_to_message.photo || msg.reply_to_message.document?.mime_type?.startsWith('image/'))
  ) {
    return await handleImageEditFromMessage(msg, captionPrompt || text)
  }

  if (chatType === 'group' || chatType === 'supergroup') {
    const isReply = msg.reply_to_message?.from?.id === bot.botInfo.id

    if (isReply) {
      const question = text
      if (question.split(' ').length <= 1) {
        return bot.sendMessage(msg.chat.id, 'Pertanyaan Anda terlalu pendek. Harap berikan pertanyaan yang lebih lengkap.', {
          reply_to_message_id: msg.message_id,
        })
      }

      const replyText = msg.reply_to_message.text || ''
      return await handleQuestion(msg, question, replyText)
    }
  }

  if (!text) return

  if (chatType === 'private') {
    if (
      text.startsWith('/start') ||
      text.startsWith('/help') ||
      text.startsWith('/tanya ') ||
      text.startsWith('/gambar ')
    ) return

    if (!msg.reply_to_message || !msg.reply_to_message.text) {
      return bot.sendMessage(msg.chat.id,
        `Silakan balas (reply) pesan sebelumnya untuk melanjutkan percakapan,

atau gunakan perintah berikut untuk memulai percakapan baru:

/tanya [pertanyaan Anda]
/gambar [deskripsi gambar]`,
        { reply_to_message_id: msg.message_id })
    }

    const question = text
    const replyText = msg.reply_to_message.text || ''

    if (question.split(' ').length <= 1) {
      return bot.sendMessage(msg.chat.id, 'Pertanyaan Anda terlalu pendek. Harap berikan pertanyaan yang lebih lengkap.', {
        reply_to_message_id: msg.message_id,
      })
    }

    return await handleQuestion(msg, question, replyText)
  }
})

bot.on('new_chat_members', msg => {
  const newMembers = msg.new_chat_members
  const isBotAdded = newMembers.some(member => member.id === bot.botInfo.id)

  if (isBotAdded) {
    const startMessage = `Author: @RiProG
Channel: @RiOpSo
Group: @RiOpSoDisc

Support me: https://t.me/RiOpSo/2848

Source Code: https://github.com/RiProG-id/gemini-telegram-bot

Gunakan perintah:
/tanya [pertanyaan Anda]
/gambar [deskripsi gambar]`

    bot.sendMessage(msg.chat.id, startMessage)
  }
})

bot.getMe()
  .then(info => {
    bot.botInfo = info
    console.log(`Bot is running as @${info.username}`)
  })
  .catch(err => {
    console.error('Failed to get bot info:', err)
  })