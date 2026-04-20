import { buildContents, streamGeminiToNdjson } from '../../../_lib/gemini';

export const onRequestPost = async (context: any) => {
  try {
    const { messages, model, systemInstruction, webSearchEnabled = true } = await context.request.json();
    const contents = await buildContents(messages || []);

    return streamGeminiToNdjson(context, model, {
      contents,
      systemInstruction,
      generationConfig: {
        temperature: 0.7,
      },
      ...(webSearchEnabled ? { tools: [{ googleSearch: {} }] } : {}),
    });
  } catch (error) {
    console.error('Gemini stream proxy failed:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Stream proxy failed.' },
      { status: 500 },
    );
  }
};
