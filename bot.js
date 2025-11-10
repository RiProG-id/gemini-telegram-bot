import "dotenv/config";
import { Telegraf } from "telegraf";
import { GoogleGenAI } from "@google/genai";
import fs from "fs/promises";
import axios from "axios";
import telegramifyMarkdown from "telegramify-markdown";

const {
  TELEGRAM_BOT_TOKEN,
  GOOGLE_API_KEY,
  GOOGLE_MODEL_TEXT,
  GOOGLE_MODEL_IMAGE,
} = process.env;

console.log("🟢 Starting bot with config:", {
  TELEGRAM_BOT_TOKEN: TELEGRAM_BOT_TOKEN ? "✅ Loaded" : "❌ Missing",
  GOOGLE_API_KEY: GOOGLE_API_KEY ? "✅ Loaded" : "❌ Missing",
  GOOGLE_MODEL_TEXT,
  GOOGLE_MODEL_IMAGE,
});

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const ai = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });

const fetchDefault = async (url, options = {}) => {
  try {
    const config = {
      method: options.method || "get",
      url,
      headers: options.headers || {},
      data: options.body || null,
      responseType: options.responseType || "json",
    };
    const response = await axios(config);
    return config.responseType === "json" ||
      config.responseType === "arraybuffer"
      ? response.data
      : response;
  } catch (err) {
    console.error("❌ fetchDefault error:", err.message);
    throw err;
  }
};

const readPersona = async () => {
  try {
    const content = (await fs.readFile("./persona.txt", "utf-8")).trim();
    console.log("📘 Persona loaded");
    return content || null;
  } catch {
    console.log("⚪ No persona.txt found");
    return null;
  }
};

const buildContentText = async (persona, replyText, question) =>
  [persona, replyText, question].filter(Boolean).join("\n\n");

const splitSafeChunks = (text, maxLength = 3500) => {
  const paragraphs = text.split("\n\n");
  const chunks = [];
  let current = "";
  for (const p of paragraphs) {
    if ((current + "\n\n" + p).length <= maxLength) {
      current += (current ? "\n\n" : "") + p;
    } else {
      if (current) chunks.push(current);
      current = p;
    }
  }
  if (current) chunks.push(current);
  return chunks;
};

const replyInChunks = async (ctx, text) => {
  const chunks = splitSafeChunks(text);
  for (const chunk of chunks) {
    const safeText = telegramifyMarkdown(chunk, "escape");
    try {
      await ctx.reply(safeText, {
        reply_to_message_id: ctx.message.message_id,
        parse_mode: "MarkdownV2",
        disable_web_page_preview: false,
      });
    } catch (err) {
      console.error("❌ Markdown parse error:", err.message);
      await ctx.reply(
        "Terjadi kesalahan saat mengirim balasan (format markdown).",
        { reply_to_message_id: ctx.message.message_id },
      );
    }
  }
};

const handleQuestion = async (ctx, question, replyText = "") => {
  try {
    const persona = await readPersona();
    const content = await buildContentText(persona, replyText, question);
    console.log("📤 Sending to Gemini:", content.slice(0, 200), "...");
    const res = await ai.models.generateContent({
      model: GOOGLE_MODEL_TEXT,
      contents: content,
      tools: [{ googleSearch: {} }],
    });
    console.log("📥 Gemini response raw:", res);
    const answer = res.response?.text || res.text || "Maaf, tidak ada jawaban.";
    console.log("✅ Answer received:", answer.slice(0, 150), "...");
    await replyInChunks(ctx, answer);
  } catch (err) {
    console.error("❌ handleQuestion error:", err);
    await ctx.reply("Maaf, terjadi kesalahan saat memproses pertanyaan Anda.", {
      reply_to_message_id: ctx.message.message_id,
    });
  }
};

const handleImageRequest = async (ctx, prompt) => {
  try {
    const res = await ai.models.generateContent({
      model: GOOGLE_MODEL_IMAGE,
      contents: prompt,
    });
    let sent = false;
    for (const part of res.parts || []) {
      if (part.text) {
        const text = telegramifyMarkdown(part.text, "escape");
        await ctx.reply(text, {
          reply_to_message_id: ctx.message.message_id,
          parse_mode: "MarkdownV2",
          disable_web_page_preview: true,
        });
      } else if (part.inlineData) {
        const buffer = Buffer.from(part.inlineData.data, "base64");
        const fileName = `image_${ctx.message.message_id}.png`;
        await fs.writeFile(fileName, buffer);
        await ctx.replyWithPhoto(
          { source: fileName },
          { reply_to_message_id: ctx.message.message_id },
        );
        await fs.unlink(fileName);
        sent = true;
      }
    }
    if (!sent)
      await ctx.reply("Maaf, tidak dapat membuat gambar.", {
        reply_to_message_id: ctx.message.message_id,
      });
  } catch (err) {
    console.error("❌ handleImageRequest error:", err);
    await ctx.reply("Terjadi kesalahan saat membuat gambar.", {
      reply_to_message_id: ctx.message.message_id,
    });
  }
};

const handleImageEditFromMessage = async (ctx, prompt) => {
  let photo =
    ctx.message.photo?.slice(-1)[0] ||
    ctx.message.reply_to_message?.photo?.slice(-1)[0] ||
    null;
  if (
    !photo &&
    ctx.message.reply_to_message?.document?.mime_type?.startsWith("image/")
  )
    photo = ctx.message.reply_to_message.document;
  if (!photo) return;

  try {
    const fileLink = await ctx.telegram.getFileLink(photo.file_id);
    const res = await fetchDefault(fileLink.href || fileLink, {
      responseType: "arraybuffer",
    });
    const base64Image = Buffer.from(res).toString("base64");
    if (!prompt)
      return ctx.reply("Deskripsi gambar tidak boleh kosong.", {
        reply_to_message_id: ctx.message.message_id,
      });

    const contents = [
      { text: prompt },
      { inlineData: { mimeType: "image/jpeg", data: base64Image } },
    ];
    const response = await ai.models.generateContent({
      model: GOOGLE_MODEL_IMAGE,
      contents,
    });

    for (const part of response.parts || []) {
      if (part.text) {
        const text = telegramifyMarkdown(part.text, "escape");
        await ctx.reply(text, {
          reply_to_message_id: ctx.message.message_id,
          parse_mode: "MarkdownV2",
          disable_web_page_preview: true,
        });
      } else if (part.inlineData) {
        const buffer = Buffer.from(part.inlineData.data, "base64");
        const fileName = `image_edit_${ctx.message.message_id}.png`;
        await fs.writeFile(fileName, buffer);
        await ctx.replyWithPhoto(
          { source: fileName },
          { reply_to_message_id: ctx.message.message_id },
        );
        await fs.unlink(fileName);
      }
    }
  } catch (err) {
    console.error("❌ handleImageEditFromMessage error:", err);
    await ctx.reply("Terjadi kesalahan saat memproses gambar.", {
      reply_to_message_id: ctx.message.message_id,
    });
  }
};

bot.catch((err, ctx) => console.error(`💥 Error for ${ctx.updateType}:`, err));

const welcomeMsg = `Author: @RiProG
Channel: @RiOpSo
Group: @RiOpSoDisc

Support me: https://t.me/RiOpSo/2848
Source Code: https://github.com/RiProG-id/gemini-telegram-bot

Gunakan perintah:
/tanya [pertanyaan Anda]
/gambar [deskripsi gambar]`;

bot.start((ctx) => ctx.reply(welcomeMsg));
bot.help((ctx) => ctx.reply(welcomeMsg));

bot.command("tanya", async (ctx) => {
  const question = ctx.message.text.replace(/^\/tanya\s+/, "").trim();
  const replyText =
    ctx.message.reply_to_message?.from?.id === ctx.botInfo.id
      ? ctx.message.reply_to_message.text
      : "";
  await handleQuestion(ctx, question, replyText);
});

bot.command("gambar", async (ctx) => {
  const prompt = ctx.message.text.replace(/^\/gambar\s+/, "").trim();
  if (!prompt)
    return ctx.reply("Deskripsi gambar tidak boleh kosong.", {
      reply_to_message_id: ctx.message.message_id,
    });
  await handleImageRequest(ctx, prompt);
});

bot.on("message", async (ctx) => {
  const msg = ctx.message;
  const { type } = msg.chat;
  const text = msg.text?.trim() || "";
  const caption = msg.caption?.trim() || "";
  const promptText = caption || text;

  if (type === "private") {
    let replyText = "";
    if (msg.reply_to_message?.from?.id === ctx.botInfo.id)
      replyText = msg.reply_to_message.text;
    await handleQuestion(ctx, text, replyText);

    if (
      msg.photo ||
      msg.reply_to_message?.photo ||
      msg.reply_to_message?.document?.mime_type?.startsWith("image/")
    ) {
      await handleImageEditFromMessage(ctx, promptText);
    }
  }

  if (["group", "supergroup"].includes(type)) {
    const isReplyToBot = msg.reply_to_message?.from?.id === ctx.botInfo.id;
    const isCommandGambar =
      text.startsWith("/gambar") || caption.startsWith("/gambar");

    if (text && isReplyToBot) {
      await handleQuestion(ctx, text, msg.reply_to_message.text);
    }

    if (
      (msg.photo ||
        msg.reply_to_message?.photo ||
        msg.reply_to_message?.document?.mime_type?.startsWith("image/")) &&
      (isCommandGambar || isReplyToBot)
    ) {
      await handleImageEditFromMessage(ctx, promptText);
    }
  }
});

bot.on("new_chat_members", async (ctx) => {
  if (ctx.message.new_chat_members?.some((m) => m.id === ctx.botInfo.id)) {
    await ctx.reply(welcomeMsg);
  }
});

(async () => {
  try {
    const updates = await fetchDefault(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=-1`,
    );
    const lastId = updates?.result?.[0]?.update_id;
    if (lastId !== undefined)
      await fetchDefault(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastId + 1}`,
      );
  } catch (err) {
    console.error("⚠️ getUpdates error:", err.message);
  }

  try {
    const info = await bot.telegram.getMe();
    bot.botInfo = info;
    console.log(`🤖 Bot is running as @${info.username}`);
    await bot.launch();
  } catch (err) {
    console.error("🚨 Failed to get bot info:", err.message);
  }
})();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
