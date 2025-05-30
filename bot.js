import "dotenv/config";
import { Telegraf } from "telegraf";
import { GoogleGenAI, Modality } from "@google/genai";
import fs from "fs/promises";
import dns from "dns/promises";
import https from "https";

let fetchFn;
try {
  fetchFn = fetch;
} catch {
  fetchFn = (await import("node-fetch")).default;
}

async function resolveIP(hostname) {
  try {
    const ips = await dns.resolve4(hostname);
    return ips[0];
  } catch (err) {
    console.error(`Gagal resolve IP untuk ${hostname}:`, err);
    return null;
  }
}

async function createHttpsAgentWithResolvedIP(hostname) {
  const ip = await resolveIP(hostname);
  if (!ip) return null;

  return new https.Agent({
    host: ip,
    servername: hostname,
    lookup: (hostnameToLookup, options, callback) => {
      if (hostnameToLookup === hostname) {
        callback(null, ip, 4);
      } else {
        dns.lookup(hostnameToLookup, options, callback);
      }
    },
  });
}

const telegramAgent = await createHttpsAgentWithResolvedIP("api.telegram.org");
const googleAgent = await createHttpsAgentWithResolvedIP(
  "generativelanguage.googleapis.com",
);

async function fetchWithAgent(url, options = {}) {
  let agent;
  if (url.includes("api.telegram.org")) agent = telegramAgent;
  else if (url.includes("generativelanguage.googleapis.com"))
    agent = googleAgent;
  else agent = null;

  if (agent) {
    options.agent = agent;
  }
  return fetchFn(url, options);
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN, {
  telegram: { agent: telegramAgent },
});

const ai = new GoogleGenAI({
  apiKey: process.env.GOOGLE_API_KEY,
  fetchOptions: { agent: googleAgent },
});

const userConversations = new Map();

async function readPersona() {
  try {
    const content = await fs.readFile("./persona.txt", "utf-8");
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

async function buildContentText(persona, replyText, question) {
  let combined = "";
  if (persona) combined += persona + "\n\n---\n\n";
  if (replyText) combined += replyText + "\n\n";
  combined += question;
  return combined;
}

async function handleQuestion(ctx, question, replyText = "") {
  const persona = await readPersona();
  const content = await buildContentText(persona, replyText, question);

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [{ role: "user", parts: [{ text: content }] }],
      config: {
        tools: [{ googleSearch: {} }],
      },
    });

    const answer =
      response.candidates?.[0]?.content?.parts?.map((p) => p.text).join(" ") ||
      "Maaf, tidak ada jawaban.";

    let finalReply = `<b>Jawaban:</b>\n${answer}`;

    const grounding =
      response.candidates?.[0]?.groundingMetadata?.searchEntryPoint
        ?.renderedContent;
    if (grounding) {
      finalReply += `\n\n<b>Sumber dari Google Search:</b>\n${grounding}`;
    }

    await ctx.reply(finalReply, {
      reply_to_message_id: ctx.message.message_id,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    });
  } catch (error) {
    console.error("handleQuestion error:", error);
    await ctx.reply("Maaf, terjadi kesalahan saat memproses pertanyaan Anda.", {
      reply_to_message_id: ctx.message.message_id,
    });
  }
}

async function handleImageRequest(ctx, prompt) {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash-preview-image-generation",
      contents: [{ text: prompt }],
      config: { responseModalities: [Modality.TEXT, Modality.IMAGE] },
    });

    let imageSent = false;
    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.text) {
        await ctx.reply(part.text, {
          reply_to_message_id: ctx.message.message_id,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        });
      } else if (part.inlineData) {
        const imageData = part.inlineData.data;
        const buffer = Buffer.from(imageData, "base64");
        const fileName = `image_${ctx.message.message_id}.png`;
        await fs.writeFile(fileName, buffer);
        await ctx.replyWithPhoto(
          { source: fileName },
          { reply_to_message_id: ctx.message.message_id },
        );
        await fs.unlink(fileName);
        imageSent = true;
      }
    }

    if (!imageSent) {
      await ctx.reply("Maaf, tidak dapat membuat gambar.", {
        reply_to_message_id: ctx.message.message_id,
      });
    }
  } catch (error) {
    console.error("handleImageRequest error:", error);
    await ctx.reply("Terjadi kesalahan saat membuat gambar.", {
      reply_to_message_id: ctx.message.message_id,
    });
  }
}

async function handleImageEditFromMessage(ctx, captionPrompt) {
  let photo = null;

  if (
    ctx.message.reply_to_message?.from?.id === ctx.botInfo.id &&
    (ctx.message.reply_to_message.photo ||
      ctx.message.reply_to_message.document?.mime_type?.startsWith("image/"))
  ) {
    photo = ctx.message.reply_to_message.photo?.slice(-1)[0] || null;
  } else {
    photo =
      ctx.message.photo?.slice(-1)[0] ||
      ctx.message.reply_to_message?.photo?.slice(-1)[0] ||
      null;
  }

  if (!photo) return;

  try {
    const fileLink = await ctx.telegram.getFileLink(photo.file_id);
    const res = await fetchWithAgent(fileLink.href || fileLink);
    const buffer = await res.arrayBuffer();
    const base64Image = Buffer.from(buffer).toString("base64");

    const promptText = captionPrompt?.trim();
    if (!promptText) {
      return ctx.reply("Deskripsi gambar tidak boleh kosong.", {
        reply_to_message_id: ctx.message.message_id,
      });
    }

    const contents = [
      { text: promptText },
      {
        inlineData: {
          mimeType: "image/jpeg",
          data: base64Image,
        },
      },
    ];

    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash-preview-image-generation",
      contents,
      config: { responseModalities: [Modality.TEXT, Modality.IMAGE] },
    });

    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.text) {
        await ctx.reply(part.text, {
          reply_to_message_id: ctx.message.message_id,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        });
      } else if (part.inlineData) {
        const imageData = part.inlineData.data;
        const buffer = Buffer.from(imageData, "base64");
        const fileName = `image_edit_${ctx.message.message_id}.png`;
        await fs.writeFile(fileName, buffer);
        await ctx.replyWithPhoto(
          { source: fileName },
          { reply_to_message_id: ctx.message.message_id },
        );
        await fs.unlink(fileName);
      }
    }
  } catch (error) {
    console.error("handleImageEditFromMessage error:", error);
    await ctx.reply("Terjadi kesalahan saat memproses gambar.", {
      reply_to_message_id: ctx.message.message_id,
    });
  }
}

bot.catch((err, ctx) => {
  console.error(`Error for ${ctx.updateType}`, err);
});

bot.start((ctx) => {
  const message = `Author: @RiProG Channel: @RiOpSo Group: @RiOpSoDisc

Support me: https://t.me/RiOpSo/2848

Source Code: https://github.com/RiProG-id/gemini-telegram-bot

Gunakan perintah: /tanya [pertanyaan Anda] /gambar [deskripsi gambar]`;
  return ctx.reply(message);
});

bot.help((ctx) => {
  const message = `Author: @RiProG Channel: @RiOpSo Group: @RiOpSoDisc

Support me: https://t.me/RiOpSo/2848

Source Code: https://github.com/RiProG-id/gemini-telegram-bot

Gunakan perintah: /tanya [pertanyaan Anda] /gambar [deskripsi gambar]`;
  return ctx.reply(message);
});

bot.command("tanya", async (ctx) => {
  if (ctx.message.reply_to_message?.from?.id === ctx.botInfo.id) {
    return;
  }
  const question = ctx.message.text.replace(/^\/tanya\s+/, "").trim();
  const replyText = ctx.message.reply_to_message?.text || "";
  await handleQuestion(ctx, question, replyText);
});

bot.command("gambar", async (ctx) => {
  const prompt = ctx.message.text.replace(/^\/gambar\s+/, "").trim();
  if (prompt.length === 0) {
    return ctx.reply("Deskripsi gambar tidak boleh kosong.", {
      reply_to_message_id: ctx.message.message_id,
    });
  }
  await handleImageRequest(ctx, prompt);
});

bot.on("message", async (ctx) => {
  const msg = ctx.message;
  const chatType = msg.chat.type;
  const text = msg.text?.trim() || "";
  const caption = msg.caption?.trim() || "";
  const botUsername = ctx.botInfo?.username || "";
  const isMentioned =
    text.includes(`@${botUsername}`) || caption.includes(`@${botUsername}`);

  if (chatType === "private") {
    if (
      msg.photo ||
      msg.reply_to_message?.photo ||
      msg.reply_to_message?.document?.mime_type?.startsWith("image/")
    ) {
      const promptText = caption || text;
      if (!promptText) {
        return ctx.reply("Deskripsi gambar tidak boleh kosong.", {
          reply_to_message_id: msg.message_id,
        });
      }
      return await handleImageEditFromMessage(ctx, promptText);
    }

    if (
      text.startsWith("/start") ||
      text.startsWith("/help") ||
      text.startsWith("/tanya ") ||
      text.startsWith("/gambar ")
    ) {
      return;
    }

    if (!msg.reply_to_message || !msg.reply_to_message.text) {
      return ctx.reply(
        `Silakan balas (reply) pesan sebelumnya untuk melanjutkan percakapan,

atau gunakan perintah berikut untuk memulai percakapan baru: /tanya [pertanyaan Anda] /gambar [deskripsi gambar]`,
        {
          reply_to_message_id: msg.message_id,
        },
      );
    }

    const question = text;
    const replyText = msg.reply_to_message.text || "";
    return await handleQuestion(ctx, question, replyText);
  }

  if (chatType === "group" || chatType === "supergroup") {
    if (
      (msg.photo || msg.document?.mime_type?.startsWith("image/")) &&
      caption.startsWith("/gambar ")
    ) {
      const prompt = caption.replace("/gambar ", "").trim();
      if (!prompt) {
        return ctx.reply("Deskripsi gambar tidak boleh kosong.", {
          reply_to_message_id: msg.message_id,
        });
      }
      return await handleImageEditFromMessage(ctx, prompt);
    }

    if (
      text.startsWith("/gambar ") &&
      (msg.reply_to_message?.photo ||
        msg.reply_to_message?.document?.mime_type?.startsWith("image/"))
    ) {
      const prompt = text.replace("/gambar ", "").trim();
      if (!prompt) {
        return ctx.reply("Deskripsi gambar tidak boleh kosong.", {
          reply_to_message_id: msg.message_id,
        });
      }
      return await handleImageEditFromMessage(ctx, prompt);
    }

    if (
      msg.reply_to_message?.from?.id === ctx.botInfo.id &&
      (msg.reply_to_message.photo ||
        msg.reply_to_message.document?.mime_type?.startsWith("image/"))
    ) {
      const prompt = caption || text;
      if (!prompt) {
        return ctx.reply("Deskripsi gambar tidak boleh kosong.", {
          reply_to_message_id: msg.message_id,
        });
      }
      return await handleImageEditFromMessage(ctx, prompt);
    }

    if (
      isMentioned &&
      (msg.photo || msg.document?.mime_type?.startsWith("image/"))
    ) {
      let prompt = caption || text.replace(`@${botUsername}`, "").trim();
      if (!prompt) {
        return ctx.reply("Deskripsi gambar tidak boleh kosong.", {
          reply_to_message_id: msg.message_id,
        });
      }
      return await handleImageEditFromMessage(ctx, prompt);
    }

    const isReplyToBot = msg.reply_to_message?.from?.id === ctx.botInfo.id;
    if (isReplyToBot) {
      const question = text;
      const replyText = msg.reply_to_message.text || "";
      return await handleQuestion(ctx, question, replyText);
    }

    if (text.includes(`@${botUsername}`)) {
      const question = text.replace(`@${botUsername}`, "").trim();
      const replyText = msg.reply_to_message?.text || "";
      return await handleQuestion(ctx, question, replyText);
    }
  }

  if (!text) return;

  if (chatType === "private") {
    if (
      text.startsWith("/start") ||
      text.startsWith("/help") ||
      text.startsWith("/tanya ") ||
      text.startsWith("/gambar ")
    )
      return;

    if (!msg.reply_to_message || !msg.reply_to_message.text) {
      return ctx.reply(
        `Silakan balas (reply) pesan sebelumnya untuk melanjutkan percakapan,

atau gunakan perintah berikut untuk memulai percakapan baru: /tanya [pertanyaan Anda] /gambar [deskripsi gambar]`,
        { reply_to_message_id: msg.message_id },
      );
    }

    const question = text;
    const replyText = msg.reply_to_message.text || "";
    return await handleQuestion(ctx, question, replyText);
  }
});

bot.on("new_chat_members", async (ctx) => {
  const newMembers = ctx.message.new_chat_members || [];
  const isBotAdded = newMembers.some((member) => member.id === ctx.botInfo.id);

  if (isBotAdded) {
    const startMessage = `Author: @RiProG Channel: @RiOpSo Group: @RiOpSoDisc

Support me: https://t.me/RiOpSo/2848

Source Code: https://github.com/RiProG-id/gemini-telegram-bot

Gunakan perintah: /tanya [pertanyaan Anda] /gambar [deskripsi gambar]`;

    await ctx.reply(startMessage);
  }
});

(async () => {
  try {
    const info = await bot.telegram.getMe();
    bot.botInfo = info;
    console.log(`Bot is running as @${info.username}`);
    await bot.launch();
  } catch (err) {
    console.error("Failed to get bot info:", err);
  }
})();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
