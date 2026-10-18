// Discord polls, embeds, and message components. Pure, so both the MCP tools and the
// Cloudflare gateway can build the same payloads.

const STYLES = { primary: 1, secondary: 2, success: 3, danger: 4, link: 5 };
const SELECT_TYPES = { string: 3, text: 3, user: 5, role: 6, mentionable: 7, channel: 8 };

export function hasRich(args) {
  if (!args || typeof args !== "object") return false;
  return Boolean(args.embeds || args.components || args.poll);
}

function fail(message) {
  const err = new Error(message);
  err.code = "RICH_INPUT";
  throw err;
}

function colorOf(value) {
  if (value == null || value === "") return undefined;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffff) return value;
  if (typeof value === "string") {
    const hex = value.trim().replace(/^#/, "");
    if (/^[0-9a-fA-F]{6}$/.test(hex)) return Number.parseInt(hex, 16);
  }
  fail("embed color must be an integer from 0 to 16777215, or #RRGGBB.");
}

function text(value, field, max) {
  if (value == null) return undefined;
  if (typeof value !== "string") fail(`${field} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length > max) fail(`${field} is ${trimmed.length} characters; Discord allows ${max}.`);
  return trimmed;
}

export function buildEmbeds(embeds) {
  if (embeds == null) return undefined;
  if (!Array.isArray(embeds) || !embeds.length) fail("embeds must be a non-empty array.");
  if (embeds.length > 10) fail("Discord allows at most 10 embeds on a message.");
  return embeds.map((embed, index) => {
    if (!embed || typeof embed !== "object") fail(`embeds[${index}] must be an object.`);
    const out = {};
    const title = text(embed.title, `embeds[${index}].title`, 256);
    const description = text(embed.description, `embeds[${index}].description`, 4096);
    const url = text(embed.url, `embeds[${index}].url`, 2048);
    const footer = text(embed.footer, `embeds[${index}].footer`, 2048);
    const author = text(embed.author, `embeds[${index}].author`, 256);
    const thumbnail = text(embed.thumbnail_url, `embeds[${index}].thumbnail_url`, 2048);
    const image = text(embed.image_url, `embeds[${index}].image_url`, 2048);
    if (title) out.title = title;
    if (description) out.description = description;
    if (url) out.url = url;
    const color = colorOf(embed.color);
    if (color != null) out.color = color;
    if (footer) out.footer = { text: footer };
    if (author) out.author = { name: author };
    if (thumbnail) out.thumbnail = { url: thumbnail };
    if (image) out.image = { url: image };
    if (embed.timestamp) {
      const stamp = text(embed.timestamp, `embeds[${index}].timestamp`, 40);
      if (Number.isNaN(Date.parse(stamp))) fail(`embeds[${index}].timestamp must be an ISO-8601 time.`);
      out.timestamp = new Date(stamp).toISOString();
    }
    if (embed.fields != null) {
      if (!Array.isArray(embed.fields) || embed.fields.length > 25) fail(`embeds[${index}].fields must be an array of at most 25.`);
      out.fields = embed.fields.map((field, fieldIndex) => {
        const name = text(field?.name, `embeds[${index}].fields[${fieldIndex}].name`, 256);
        const value = text(field?.value, `embeds[${index}].fields[${fieldIndex}].value`, 1024);
        if (!name || !value) fail(`embeds[${index}].fields[${fieldIndex}] needs name and value.`);
        return { name, value, ...(field.inline ? { inline: true } : {}) };
      });
    }
    if (!Object.keys(out).length) fail(`embeds[${index}] is empty.`);
    return out;
  });
}

function button(raw, row, index) {
  if (!raw || typeof raw !== "object") fail(`components[${row}].buttons[${index}] must be an object.`);
  const styleName = String(raw.style ?? "primary").toLowerCase();
  const style = STYLES[styleName] ?? (Number.isInteger(raw.style) ? raw.style : null);
  if (![1, 2, 3, 4, 5].includes(style)) fail(`components[${row}].buttons[${index}].style must be primary, secondary, success, danger, or link.`);
  const label = text(raw.label, `components[${row}].buttons[${index}].label`, 80);
  if (!label) fail(`components[${row}].buttons[${index}] needs a label.`);
  const out = { type: 2, style, label };
  if (style === 5) {
    const url = text(raw.url, `components[${row}].buttons[${index}].url`, 512);
    if (!url || !/^https?:\/\//.test(url)) fail(`components[${row}].buttons[${index}] is a link button and needs an http(s) url.`);
    out.url = url;
  } else {
    const customId = text(raw.custom_id, `components[${row}].buttons[${index}].custom_id`, 100);
    if (!customId) fail(`components[${row}].buttons[${index}] needs custom_id.`);
    out.custom_id = customId;
  }
  if (raw.disabled) out.disabled = true;
  return out;
}

function select(raw, row) {
  if (!raw || typeof raw !== "object") fail(`components[${row}].select must be an object.`);
  const type = SELECT_TYPES[String(raw.type ?? "string").toLowerCase()] ?? null;
  if (!type) fail(`components[${row}].select.type must be string, user, role, mentionable, or channel.`);
  const customId = text(raw.custom_id, `components[${row}].select.custom_id`, 100);
  if (!customId) fail(`components[${row}].select needs custom_id.`);
  const out = { type, custom_id: customId };
  const placeholder = text(raw.placeholder, `components[${row}].select.placeholder`, 150);
  if (placeholder) out.placeholder = placeholder;
  if (type === 3) {
    if (!Array.isArray(raw.options) || !raw.options.length || raw.options.length > 25) fail(`components[${row}].select.options must have 1 to 25 choices.`);
    out.options = raw.options.map((option, index) => {
      const label = text(option?.label, `components[${row}].select.options[${index}].label`, 100);
      const value = text(option?.value, `components[${row}].select.options[${index}].value`, 100);
      if (!label || !value) fail(`components[${row}].select.options[${index}] needs label and value.`);
      const description = text(option.description, `components[${row}].select.options[${index}].description`, 100);
      return { label, value, ...(description ? { description } : {}) };
    });
  }
  if (raw.min_values != null) out.min_values = raw.min_values;
  if (raw.max_values != null) out.max_values = raw.max_values;
  return out;
}

export function buildComponents(components) {
  if (components == null) return undefined;
  if (!Array.isArray(components) || !components.length) fail("components must be a non-empty array of action rows.");
  if (components.length > 5) fail("Discord allows at most 5 action rows.");
  return components.map((row, index) => {
    if (!row || typeof row !== "object") fail(`components[${index}] must be an object.`);
    if (row.buttons && row.select) fail(`components[${index}] must be buttons or a select menu, not both.`);
    if (row.buttons) {
      if (!Array.isArray(row.buttons) || !row.buttons.length || row.buttons.length > 5) fail(`components[${index}].buttons must have 1 to 5 buttons.`);
      return { type: 1, components: row.buttons.map((item, buttonIndex) => button(item, index, buttonIndex)) };
    }
    if (row.select) return { type: 1, components: [select(row.select, index)] };
    fail(`components[${index}] needs buttons or select.`);
  });
}

export function buildPoll(poll) {
  if (poll == null) return undefined;
  if (!poll || typeof poll !== "object") fail("poll must be an object.");
  const question = text(poll.question, "poll.question", 300);
  if (!question) fail("poll.question is required.");
  if (!Array.isArray(poll.answers) || poll.answers.length < 1 || poll.answers.length > 10) fail("poll.answers needs 1 to 10 answers.");
  const answers = poll.answers.map((answer, index) => {
    const value = typeof answer === "string" ? answer : answer?.text;
    const label = text(value, `poll.answers[${index}]`, 55);
    if (!label) fail(`poll.answers[${index}] needs text.`);
    const emoji = typeof answer === "object" ? text(answer.emoji, `poll.answers[${index}].emoji`, 80) : undefined;
    return { poll_media: { text: label, ...(emoji ? { emoji: { name: emoji } } : {}) } };
  });
  const duration = poll.duration_hours == null ? 24 : poll.duration_hours;
  if (!Number.isInteger(duration) || duration < 1 || duration > 768) fail("poll.duration_hours must be an integer from 1 to 768.");
  return {
    question: { text: question },
    answers,
    duration,
    allow_multiselect: Boolean(poll.multiselect),
    layout_type: 1,
  };
}

// REST fields for one Discord message. Rich parts only fit on a single message.
export function richFields(args) {
  if (!hasRich(args)) return null;
  const fields = {};
  const embeds = buildEmbeds(args.embeds);
  const components = buildComponents(args.components);
  const poll = buildPoll(args.poll);
  if (embeds) fields.embeds = embeds;
  if (components) fields.components = components;
  if (poll) fields.poll = poll;
  return fields;
}

export const EMBED_SCHEMA = {
  type: "array",
  maxItems: 10,
  description: "Embeds to attach (title, description, color, fields, and so on). Up to 10.",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string" },
      description: { type: "string" },
      url: { type: "string" },
      color: { description: "Integer 0–16777215, or #RRGGBB." },
      fields: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            value: { type: "string" },
            inline: { type: "boolean" },
          },
          required: ["name", "value"],
        },
      },
      footer: { type: "string" },
      author: { type: "string" },
      thumbnail_url: { type: "string" },
      image_url: { type: "string" },
      timestamp: { type: "string", description: "ISO-8601 time shown on the embed." },
    },
  },
};

export const COMPONENTS_SCHEMA = {
  type: "array",
  maxItems: 5,
  description: "Message components. Each item is one action row: either buttons, or one select menu. Presses and selections are queued in the inbox on the hosted bot.",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      buttons: {
        type: "array",
        maxItems: 5,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            label: { type: "string" },
            custom_id: { type: "string", description: "Required unless style is link." },
            style: { type: "string", enum: ["primary", "secondary", "success", "danger", "link"], default: "primary" },
            url: { type: "string", description: "Required when style is link." },
            disabled: { type: "boolean" },
          },
          required: ["label"],
        },
      },
      select: {
        type: "object",
        additionalProperties: false,
        properties: {
          custom_id: { type: "string" },
          placeholder: { type: "string" },
          type: { type: "string", enum: ["string", "user", "role", "mentionable", "channel"], default: "string" },
          options: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                label: { type: "string" },
                value: { type: "string" },
                description: { type: "string" },
              },
              required: ["label", "value"],
            },
          },
          min_values: { type: "integer" },
          max_values: { type: "integer" },
        },
        required: ["custom_id"],
      },
    },
  },
};

export const POLL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  description: "A Discord poll attached to the message.",
  properties: {
    question: { type: "string" },
    answers: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      items: {
        anyOf: [
          { type: "string" },
          {
            type: "object",
            additionalProperties: false,
            properties: { text: { type: "string" }, emoji: { type: "string" } },
            required: ["text"],
          },
        ],
      },
    },
    duration_hours: { type: "integer", minimum: 1, maximum: 768, default: 24 },
    multiselect: { type: "boolean", default: false },
  },
  required: ["question", "answers"],
};

// Merge gateway notes onto messages from REST. `notes.deleted` are tombstones to show.
export function applyRevisions(messages, notes) {
  if (!notes) return messages;
  const byId = notes.byId ?? {};
  const out = messages.map((message) => {
    const rev = byId[message.id];
    if (!rev) return message;
    return {
      ...message,
      content: rev.content ?? message.content,
      edited: Boolean(rev.edited) || Boolean(message.edited),
      edited_timestamp: message.edited_timestamp || (rev.edited ? rev.editedAt : null) || null,
      deleted: Boolean(rev.deleted),
    };
  });
  for (const tomb of notes.deleted ?? []) {
    if (!tomb?.id || out.some((message) => message.id === tomb.id)) continue;
    out.push({
      id: tomb.id,
      type: 0,
      timestamp: tomb.at || "1970-01-01T00:00:00.000Z",
      author: tomb.author ?? { username: "unknown" },
      content: tomb.content ?? "",
      deleted: true,
    });
  }
  return out;
}
