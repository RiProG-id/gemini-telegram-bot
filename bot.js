import "dotenv/config";
import { Telegraf } from "telegraf";
import { GoogleGenAI, Modality } from "@google/genai";
import fs from "fs/promises";
import axios from "axios";
import telegramifyMarkdown from "telegramify-markdown";

const {
  TELEGRAM_BOT_TOKEN,
  GOOGLE_API_KEY,
  GOOGLE_MODEL_TEXT,
  GOOGLE_MODEL_IMAGE,
} = process.env;

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const ai = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });

const fetchDefault = async (url, options = {}) => {
  const config = {
    method: options.method || "get",
    url,
    headers: options.headers || {},
    data: options.body || null,
    responseType: options.responseType || "json",
  };
  const response = await axios(config);
  return config.responseType === "json" || config.responseType === "arraybuffer"
    ? response.data
    : response;
};

const readPersona = async () => {
  try {
    const content = (await fs.readFile("./persona.txt", "utf-8")).trim();
    return content || null;
  } catch {
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
    } catch (e) {
      console.error("Markdown parse error:", e);
      await ctx.reply(
        "Terjadi kesalahan saat mengirim balasan (format markdown).",
        {
          reply_to_message_id: ctx.message.message_id,
        },
      );
    }
  }
};

const handleQuestion = async (ctx, question, replyText = "") => {
  try {
    const persona = await readPersona();
    const content = await buildContentText(persona, replyText, question);
    const res = await ai.models.generateContent({
      model: GOOGLE_MODEL_TEXT,
      contents: [{ role: "user", parts: [{ text: content }] }],
      config: { tools: [{ googleSearch: {} }] },
    });
    const answer =
      res.candidates?.[0]?.content?.parts?.map((p) => p.text).join(" ") ||
      "Maaf, tidak ada jawaban.";
    await replyInChunks(ctx, answer);
  } catch (e) {
    console.error("handleQuestion error:", e);
    await ctx.reply("Maaf, terjadi kesalahan saat memproses pertanyaan Anda.", {
      reply_to_message_id: ctx.message.message_id,
    });
  }
};

const handleImageRequest = async (ctx, prompt) => {
  try {
    const res = await ai.models.generateContent({
      model: GOOGLE_MODEL_IMAGE,
      contents: [{ text: prompt }],
      config: { responseModalities: [Modality.TEXT, Modality.IMAGE] },
    });

    let sent = false;
    for (const part of res.candidates?.[0]?.content?.parts || []) {
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
  } catch (e) {
    console.error("handleImageRequest error:", e);
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
      config: { responseModalities: [Modality.TEXT, Modality.IMAGE] },
    });

    for (const part of response.candidates?.[0]?.content?.parts || []) {
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
  } catch (e) {
    console.error("handleImageEditFromMessage error:", e);
    await ctx.reply("Terjadi kesalahan saat memproses gambar.", {
      reply_to_message_id: ctx.message.message_id,
    });
  }
};

bot.catch((err, ctx) => console.error(`Error for ${ctx.updateType}:`, err));

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
  if (ctx.message.reply_to_message?.from?.id === ctx.botInfo.id) return;
  const question = ctx.message.text.replace(/^\/tanya\s+/, "").trim();
  const replyText = ctx.message.reply_to_message?.text || "";
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
  const botUsername = ctx.botInfo?.username || "";
  const isMention =
    text.includes(`@${botUsername}`) || caption.includes(`@${botUsername}`);
  const promptText = caption || text;

  if (type === "private") {
    if (
      msg.photo ||
      msg.reply_to_message?.photo ||
      msg.reply_to_message?.document?.mime_type?.startsWith("image/")
    )
      return await handleImageEditFromMessage(ctx, promptText);

    if (!/^\/(start|help|tanya |gambar )/.test(text)) {
      if (!msg.reply_to_message?.text)
        return ctx.reply(
          `Silakan balas pesan sebelumnya atau gunakan perintah:\n/tanya [pertanyaan Anda]\n/gambar [deskripsi gambar]`,
          {
            reply_to_message_id: msg.message_id,
          },
        );
      await handleQuestion(ctx, text, msg.reply_to_message.text);
    }
  }

  if (["group", "supergroup"].includes(type)) {
    if (
      (msg.photo || msg.document?.mime_type?.startsWith("image/")) &&
      caption.startsWith("/gambar ")
    ) {
      const prompt = caption.replace("/gambar ", "").trim();
      return await handleImageEditFromMessage(ctx, prompt);
    }

    if (
      text.startsWith("/gambar ") &&
      (msg.reply_to_message?.photo ||
        msg.reply_to_message?.document?.mime_type?.startsWith("image/"))
    )
      return await handleImageEditFromMessage(
        ctx,
        text.replace("/gambar ", "").trim(),
      );

    if (
      msg.reply_to_message?.from?.id === ctx.botInfo.id &&
      (msg.reply_to_message.photo ||
        msg.reply_to_message.document?.mime_type?.startsWith("image/"))
    )
      return await handleImageEditFromMessage(ctx, promptText);

    if (
      isMention &&
      (msg.photo || msg.document?.mime_type?.startsWith("image/"))
    )
      return await handleImageEditFromMessage(
        ctx,
        promptText.replace(`@${botUsername}`, "").trim(),
      );

    if (msg.reply_to_message?.from?.id === ctx.botInfo.id)
      return await handleQuestion(ctx, text, msg.reply_to_message.text);

    if (text.includes(`@${botUsername}`))
      return await handleQuestion(
        ctx,
        text.replace(`@${botUsername}`, "").trim(),
        msg.reply_to_message?.text || "",
      );
  }
});

bot.on("new_chat_members", async (ctx) => {
  if (ctx.message.new_chat_members?.some((m) => m.id === ctx.botInfo.id))
    await ctx.reply(welcomeMsg);
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
  } catch {}

  try {
    const info = await bot.telegram.getMe();
    bot.botInfo = info;
    console.log(`Bot is running as @${info.username}`);
    await bot.launch();
  } catch (e) {
    console.error("Failed to get bot info:", e);
  }
})();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
