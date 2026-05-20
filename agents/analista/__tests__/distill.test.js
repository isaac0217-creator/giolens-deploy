/**
 * GioLens — agents/analista/distill.js · tests de la capability C.2.5
 *
 * Cubre distillConversations + normalizeDistilled (schema strict PRE-5).
 * callClaude se mockea: la distilación no debe depender de Anthropic real.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const callClaudeMock = vi.fn();
vi.mock('../../_shared/anthropic.js', () => ({
  callClaude: (...args) => callClaudeMock(...args),
  callAnthropic: (...args) => callClaudeMock(...args),
}));

const { distillConversations, normalizeDistilled } = await import('../distill.js');

const claudeText = (obj) => ({
  content: [{ type: 'text', text: JSON.stringify(obj) }],
  usage: { input_tokens: 200, output_tokens: 80 },
  error: null,
});

beforeEach(() => {
  callClaudeMock.mockReset();
});

describe('normalizeDistilled (schema strict PRE-5)', () => {
  it('repara sentiment inválido → neutral', () => {
    const o = normalizeDistilled({ contact_id: 'c1', sentiment: 'eufórico' }, 'c1');
    expect(o.sentiment).toBe('neutral');
  });

  it('rellena summary/next_action vacíos con defaults', () => {
    const o = normalizeDistilled({ contact_id: 'c1' }, 'c1');
    expect(o.summary).toBe('sin_resumen');
    expect(o.next_action).toBe('sin_accion');
    expect(o.objections).toEqual([]);
  });

  it('usa el contactId de fallback si el item no lo trae', () => {
    const o = normalizeDistilled({}, 'fallback-id');
    expect(o.contact_id).toBe('fallback-id');
  });

  it('preserva campos válidos', () => {
    const o = normalizeDistilled(
      { contact_id: 'c9', summary: 'pidió precio', sentiment: 'positivo', next_action: 'enviar promo', objections: ['caro'] },
      'c9',
    );
    expect(o).toEqual({
      contact_id: 'c9',
      summary: 'pidió precio',
      sentiment: 'positivo',
      next_action: 'enviar promo',
      objections: ['caro'],
    });
  });
});

describe('distillConversations', () => {
  it('lote vacío → distilled [], sin llamar a Claude', async () => {
    const out = await distillConversations({ conversations: [] });
    expect(out.distilled).toEqual([]);
    expect(out.error).toBeNull();
    expect(callClaudeMock).not.toHaveBeenCalled();
  });

  it('conversaciones sin mensajes → placeholders, error empty_conversations', async () => {
    const out = await distillConversations({
      conversations: [{ contact_id: 'c1', messages: [] }, { contact_id: 'c2', messages: [] }],
    });
    expect(out.error).toBe('empty_conversations');
    expect(out.distilled).toHaveLength(2);
    expect(out.distilled[0].contact_id).toBe('c1');
    expect(callClaudeMock).not.toHaveBeenCalled();
  });

  it('distila conversaciones con mensajes (1 call batched)', async () => {
    callClaudeMock.mockResolvedValue(claudeText({
      distilled: [
        { contact_id: 'c1', summary: 'pidió precio de lentes', sentiment: 'positivo', next_action: 'enviar cotización', objections: [] },
        { contact_id: 'c2', summary: 'dudó por costo', sentiment: 'negativo', next_action: 'ofrecer promo', objections: ['precio alto'] },
      ],
    }));
    const out = await distillConversations({
      conversations: [
        { contact_id: 'c1', messages: [{ role: 'lead', text: '¿precio?' }] },
        { contact_id: 'c2', messages: [{ role: 'lead', text: 'está caro' }] },
      ],
      correlation_id: 'corr-d1',
    });
    expect(callClaudeMock).toHaveBeenCalledTimes(1);
    expect(out.error).toBeNull();
    expect(out.distilled).toHaveLength(2);
    expect(out.distilled[0].sentiment).toBe('positivo');
    expect(out.distilled[1].objections).toEqual(['precio alto']);
    expect(out.cost_usd).toBeGreaterThan(0);
  });

  it('respuesta del modelo con error → placeholders + error propagado', async () => {
    callClaudeMock.mockResolvedValue({ content: null, usage: null, error: 'ANTHROPIC_API_KEY missing' });
    const out = await distillConversations({
      conversations: [{ contact_id: 'c1', messages: [{ role: 'lead', text: 'hola' }] }],
    });
    expect(out.error).toBe('ANTHROPIC_API_KEY missing');
    expect(out.distilled).toHaveLength(1);
    expect(out.distilled[0].contact_id).toBe('c1');
  });

  it('JSON malformado del modelo → error parse_failed, distilled normalizado', async () => {
    callClaudeMock.mockResolvedValue({
      content: [{ type: 'text', text: 'no soy json' }],
      usage: { input_tokens: 10, output_tokens: 5 },
      error: null,
    });
    const out = await distillConversations({
      conversations: [{ contact_id: 'c1', messages: [{ role: 'lead', text: 'hola' }] }],
    });
    expect(out.error).toBe('parse_failed');
    expect(out.distilled).toHaveLength(1);
    expect(out.distilled[0].summary).toBe('sin_resumen');
  });

  it('respuesta parcial del modelo → contacto faltante recibe placeholder', async () => {
    callClaudeMock.mockResolvedValue(claudeText({
      distilled: [{ contact_id: 'c1', summary: 'ok', sentiment: 'neutral', next_action: 'seguir' }],
    }));
    const out = await distillConversations({
      conversations: [
        { contact_id: 'c1', messages: [{ role: 'lead', text: 'a' }] },
        { contact_id: 'c2', messages: [{ role: 'lead', text: 'b' }] },
      ],
    });
    expect(out.distilled).toHaveLength(2);
    expect(out.distilled[0].summary).toBe('ok');
    expect(out.distilled[1].contact_id).toBe('c2');
    expect(out.distilled[1].summary).toBe('sin_resumen');
  });
});
