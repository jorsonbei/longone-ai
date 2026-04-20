import { geminiGenerateJson } from '../../_lib/gemini';

export const onRequestPost = async (context: any) => {
  try {
    const { prompt, model } = await context.request.json();
    const response = await geminiGenerateJson(context, model, {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1 },
    });

    const text =
      response?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text || '').join('') || '';
    const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();

    return Response.json({ data: JSON.parse(cleaned) });
  } catch (error) {
    console.error('Gemini evaluate proxy failed:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Evaluate proxy failed.' },
      { status: 500 },
    );
  }
};
