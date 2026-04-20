import { geminiGenerateJson } from '../../_lib/gemini';

export const onRequestPost = async (context: any) => {
  try {
    const { prompt, model } = await context.request.json();
    const response = await geminiGenerateJson(context, model, {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2 },
    });

    const text =
      response?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text || '').join('') || '';

    return Response.json({ text: text || '未提取到明显的光性变化。' });
  } catch (error) {
    console.error('Gemini light-log proxy failed:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Light-log proxy failed.' },
      { status: 500 },
    );
  }
};
