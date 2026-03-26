// ═══════════════════════════════════════════════════════════════════════
//  NEO SEARCH WORKER — добавя се в geminisession.ts
//
//  1. Постави buildSearchTool() и SEARCH_TOOL_INSTRUCTION в същия файл.
//  2. В serve() handler-а добави searchToolDecl и searchToolInstruction
//     към response-а (виж по-долу).
// ═══════════════════════════════════════════════════════════════════════

// ── Tool declaration (изпраща се на Gemini като tools[]) ──────────────
export function buildSearchTool(workerUrl: string) {
  return {
    functionDeclarations: [
      {
        name: "search_site_content",
        description:
          "Търси в crawlнатото съдържание на сайта на клиента когато не намираш информация в предоставения бизнес контекст. " +
          "Извиквай САМО когато информацията НАИСТИНА липсва след пълно претърсване на контекста. " +
          "Не извиквай за обща информация или за неща, които вече са в контекста.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: {
              type: "STRING",
              description:
                "Конкретен search query на езика на клиента. " +
                "Пример: 'пътечка килим цена', 'легло 160x200', 'имплант цена istanbul'. " +
                "Бъди конкретен — не изпращай целия въпрос на клиента.",
            },
          },
          required: ["query"],
        },
      },
    ],
  };
}

// ── Инструкция за промпта (добавя се към fullInstruction) ─────────────
export function buildSearchToolInstruction(
  workerUrl: string,
  sessionId: string,
): string {
  return [
    ``,
    `══════════════════════════════════════════`,
    `REAL-TIME SEARCH TOOL`,
    `══════════════════════════════════════════`,
    ``,
    `Разполагаш с инструмент search_site_content за търсене в реално време.`,
    ``,
    `КОГА ДА ГО ИЗВИКАШ:`,
    `- Клиентът пита за конкретен продукт, цена, наличност или детайл`,
    `- Претърсил си ЦЕЛИЯ бизнес контекст и информацията наистина я няма`,
    `- НЕ го извиквай ако информацията е в контекста — само губи време`,
    ``,
    `КАК ДА ФОРМУЛИРАШ query:`,
    `- Кратко и конкретно: "пътечка килим кафява цена" НЕ "клиентът иска пътечка 50x100 кафява цена"`,
    `- На езика на сайта (обикновено български)`,
    `- Ключови думи от въпроса на клиента, без стоп думи`,
    ``,
    `СЛЕД КАТ ПОЛУЧИШ РЕЗУЛТАТ:`,
    `- Използвай excerpts[] директно — те са реален текст от сайта`,
    `- Предай информацията ДУМА ПО ДУМА към клиента`,
    `- Ако резултатите са празни → "Нямам тази информация пред мен — мога да Ви свържа с колега."`,
    `- session_id за търсенето е: ${sessionId}`,
  ].join("\n");
}

// ── Примерна интеграция в serve() ─────────────────────────────────────
//
// В serve() handler-а, след като изградиш fullInstruction:
//
//   const WORKER_URL = Deno.env.get("SEARCH_WORKER_URL") ?? "";
//   const WORKER_SECRET = Deno.env.get("SEARCH_WORKER_SECRET") ?? "";
//   const hasWorker = Boolean(WORKER_URL && WORKER_SECRET);
//
//   // Добави инструкцията към промпта само ако worker-ът е конфигуриран
//   const searchInstruction = hasWorker
//     ? buildSearchToolInstruction(WORKER_URL, sessionId)
//     : "";
//
//   const finalInstruction = fullInstruction + searchInstruction;
//
//   // Tool declaration за Gemini
//   const tools = hasWorker ? [buildSearchTool(WORKER_URL)] : [];
//
//   return json(200, {
//     success: true,
//     apiKey: GEMINI_API_KEY,
//     model: "gemini-2.5-flash-native-audio-preview-12-2025",
//     systemInstruction: finalInstruction,
//     tools,                    // <-- Gemini ги получава тук
//     // ... rest
//   });
//
// ── Frontend / Voice widget трябва да: ────────────────────────────────
//
// 1. Когато Gemini върне functionCall { name: "search_site_content", args: { query } }:
//
//    const resp = await fetch(`${WORKER_URL}/search`, {
//      method: "POST",
//      headers: {
//        "Content-Type": "application/json",
//        "Authorization": `Bearer ${WORKER_SECRET}`,
//      },
//      body: JSON.stringify({ session_id: SESSION_ID, query: args.query }),
//    });
//    const data = await resp.json();
//
// 2. Изпрати резултата обратно към Gemini като functionResponse:
//
//    {
//      role: "tool",
//      parts: [{
//        functionResponse: {
//          name: "search_site_content",
//          response: {
//            results: data.results,   // [{ url, title, excerpts[], score }]
//            elapsed_ms: data.elapsed_ms,
//          }
//        }
//      }]
//    }
//
// 3. Gemini продължава разговора с реалните данни от worker-а.
