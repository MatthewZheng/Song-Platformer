import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set in .env or environment.');
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const interaction = await ai.interactions.create({
    model: 'gemini-4-argon',
    input: 'Reply with the word ready.',
    generation_config: {
      thinking_level: 'low',
    },
  });

  let output = interaction.output_text ?? '';
  if (!output && Array.isArray(interaction.steps)) {
    for (const step of interaction.steps) {
      if (step.type === 'model_output' && Array.isArray(step.content)) {
        for (const item of step.content) {
          if (item.type === 'text' && typeof item.text === 'string') {
            output += item.text;
          }
        }
      }
    }
  }

  const normalized = output.trim().replace(/[^a-zA-Z]/g, '').toLowerCase();
  if (normalized === 'ready') {
    console.log('ready');
  } else {
    console.log(output.trim());
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
