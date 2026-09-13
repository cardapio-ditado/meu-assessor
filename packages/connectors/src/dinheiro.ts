/**
 * Conversao de dinheiro vindo de fonte publica para centavos exatos (10.4).
 *
 * Mora aqui, e nao dentro de um conector, porque o problema e o mesmo em todos:
 * o JSON de portal traz valor como numero de ponto flutuante, e o produto
 * guarda dinheiro em inteiro de centavos. Duplicar essa conversao seria criar
 * duas definicoes de "quanto custou", que e o tipo de divergencia que ninguem
 * percebe lendo a tela.
 */

/**
 * Converte um valor em centavos EXATOS.
 *
 * Devolve `null` quando o valor NAO cabe em centavos. Arredondar em silencio
 * trocaria o numero do registro por outro parecido; quem chama e obrigado a
 * registrar a ressalva e deixar a afirmacao para revisao, em vez de publicar um
 * valor inventado.
 *
 * `null` significa "nao sei" e nunca e substituido por zero. Zero recebido da
 * fonte, por outro lado, e um valor: veja `centavosExatos(0)`.
 */
export function centavosExatos(valor: unknown): bigint | null {
  if (typeof valor !== 'number' || !Number.isFinite(valor)) return null;
  const centavos = valor * 100;
  // A tolerancia absorve o erro de representacao binaria de valores com duas
  // casas; um valor com decimos de centavo fica fora dela.
  if (Math.abs(centavos - Math.round(centavos)) > 1e-6) return null;
  if (!Number.isSafeInteger(Math.round(centavos))) return null;
  return BigInt(Math.round(centavos));
}
