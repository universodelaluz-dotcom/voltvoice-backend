const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const gTTS = require("google-tts-api");
const https = require("https");
require("dotenv").config();

function log(message, ...args) {
  console.log(`[tts-service] ${message}`, ...args);
}

function send(res, code, payload) {
  const body = JSON.stringify(payload, null, 0);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// Normalizar rate para Windows TTS (-10 a 10)
function normalizeRate(rate) {
  if (!Number.isFinite(rate)) return null;
  // Si es WPM (>10), mapear 50-350 WPM → -10 a 10
  if (Math.abs(rate) > 10) {
    const wpm = Math.max(50, Math.min(350, rate));
    return Math.round(((wpm - 50) / 300) * 20 - 10);
  }
  return Math.max(-10, Math.min(10, Math.round(rate)));
}

// Estimar duración del audio en ms (aproximado para Google TTS)
function estimateDuration(text, rate) {
  const wordCount = Math.max(1, text.length / 5);
  const baseDuration = (wordCount / 150) * 60000;
  return Math.round(baseDuration + 300);
}

function downloadAudio(url, outputPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outputPath);
    https.get(url, (response) => {
      response.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve();
      });
    }).on("error", (err) => {
      fs.unlink(outputPath, () => {});
      reject(err);
    });
  });
}

function speak(text, options = {}) {
  return new Promise((resolve, reject) => {
    const outputFile = path.join(os.tmpdir(), `voltvoice_output_${Date.now()}.mp3`);
    const diagnosticFile = path.join(__dirname, "audio_output", `google_tts_${Date.now()}.mp3`);

    try {
      log(`Sintetizando con Google TTS: "${text.substring(0, 50)}..."`);

      // Obtener URL de audio de Google (México específicamente)
      const url = gTTS.getAudioUrl(text, {
        lang: "es-MX",
        slow: false,
      });

      // Descargar audio
      downloadAudio(url, outputFile).then(() => {
        // Diagnostics: copiar a carpeta de audio para análisis
        try {
          if (!fs.existsSync(path.join(__dirname, "audio_output"))) {
            fs.mkdirSync(path.join(__dirname, "audio_output"), { recursive: true });
          }
          const data = fs.readFileSync(outputFile);
          fs.writeFileSync(diagnosticFile, data);

          const firstBytes = data.slice(0, 20).toString('hex');
          const lastBytes = data.slice(-20).toString('hex');
          log(`[Google TTS diagnostics] Tamaño: ${data.length} bytes`);
          log(`   Primeros 20 bytes (hex): ${firstBytes}`);
          log(`   Últimos 20 bytes (hex): ${lastBytes}`);
        } catch (e) {
          log(`Warning: no se pudo diagnosticar Google TTS: ${e.message}`);
        }

        playAudio(outputFile).then(() => {
          // Limpiar archivo
          try {
            fs.unlinkSync(outputFile);
          } catch (e) {
            log("No se pudo eliminar archivo temporal:", e.message);
          }
          resolve();
        }).catch(err => {
          log("Error reproduciendo audio:", err.message);
          reject(err);
        });
      }).catch(err => {
        log("Error descargando audio:", err.message);
        reject(err);
      });
    } catch (err) {
      log("Error en Google TTS:", err.message);
      reject(err);
    }
  });
}

// Reproducir MP3 - intenta ffplay primero, fallback a cmd start
function playAudio(filePath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(filePath)) {
      log(`❌ Archivo no existe: ${filePath}`);
      resolve();
      return;
    }

    const fileSize = fs.statSync(filePath).size;
    log(`🔊 Reproduciendo: ${fileSize} bytes`);

    const { exec } = require("child_process");

    // Ruta exacta a ffplay (WinGet)
    const ffplayPath = `C:\\Users\\VOLT\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1-full_build\\bin\\ffplay.exe`;
    const escapedPath = filePath.replace(/"/g, '\\"');

    exec(`"${ffplayPath}" -nodisp -autoexit "${escapedPath}"`, {
      windowsHide: true
    }, (error) => {
      if (error) {
        log(`⚠️ Error reproduciendo: ${error.message}`);
      }
      log(`✅ Audio terminado`);
      resolve();
    });

    // Timeout para evitar que mensajes se repitan
    setTimeout(() => {
      resolve();
    }, 30000);
  });
}

// Voces disponibles en Google TTS (español)
const GOOGLE_VOICES = [
  { name: "es-MX", culture: "es-MX", type: "google" },
];

// Cargar voces clonadas personalizadas
function loadCustomVoices() {
  try {
    const customVoicesPath = path.join(__dirname, "inworld_custom_voices.json");
    if (fs.existsSync(customVoicesPath)) {
      const data = fs.readFileSync(customVoicesPath, "utf-8");
      return JSON.parse(data);
    }
  } catch (err) {
    log("Error cargando voces personalizadas:", err.message);
  }
  return {};
}

// Obtener voces disponibles de Inworld TTS (voces estándar)
let cachedInworldVoices = null;

function getInworldVoices() {
  return new Promise((resolve) => {
    // Voces estándar de Inworld (SIN prefijo - será añadido en /voices)
    const standardVoices = [
      { name: "Diego", displayName: "Diego", type: "inworld", gender: "male" },
      { name: "Lupita", displayName: "Lupita", type: "inworld", gender: "female" },
      { name: "Miguel", displayName: "Miguel", type: "inworld", gender: "male" },
      { name: "Rafael", displayName: "Rafael", type: "inworld", gender: "male" },
    ];

    cachedInworldVoices = standardVoices;
    log(`✅ Voces Inworld estándar cargadas: ${standardVoices.map(v => v.name).join(", ")}`);
    resolve(standardVoices);
  });
}

// Función para obtener voces de Windows
function getWindowsVoices() {
  return new Promise((resolve) => {
    const voicesScript = `
      Add-Type -AssemblyName System.Speech
      $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
      $synth.GetInstalledVoices() | ForEach-Object {
        Write-Output "$($_.VoiceInfo.Name)|$($_.VoiceInfo.Culture)"
      }
    `;

    const ps = spawn("powershell", ["-NoProfile", "-Command", voicesScript], {
      windowsHide: true,
      detached: false,
    });
    let output = "";

    ps.stdout.on("data", (data) => {
      output += data.toString();
    });

    ps.on("close", () => {
      const voices = output
        .trim()
        .split("\n")
        .filter(v => v.trim())
        .map(line => {
          const [name, culture] = line.split("|");
          return {
            name: `windows_${name.trim()}`,
            culture: culture?.trim() || "",
            type: "windows",
          };
        });

      resolve(voices);
    });

    ps.on("error", () => {
      resolve([]);
    });
  });
}

// Reproducir con Inworld TTS
function speakInworld(text, options = {}) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.INWORLD_API_KEY;
    const modelId = process.env.INWORLD_MODEL || "tts-1.5-max";

    if (!apiKey) {
      log("Error: INWORLD_API_KEY no configurada");
      reject(new Error("INWORLD_API_KEY not configured"));
      return;
    }

    let voiceId = "Diego"; // Default voice

    if (options.voice) {
      // Si es una voz clonada (inworld_custom_*), obtener ID del archivo
      if (options.voice.startsWith("inworld_custom_")) {
        const customVoices = loadCustomVoices();
        const customName = options.voice.replace("inworld_custom_", "").toLowerCase();
        voiceId = customVoices[customName] || "Diego";
      } else {
        // Si es una voz estándar, usar el nombre directamente
        voiceId = options.voice.replace("inworld_", "");
        // Capitalizar primera letra
        voiceId = voiceId.charAt(0).toUpperCase() + voiceId.slice(1);
      }
    }

    // Guardar en carpeta permanente para debugging
    const audioDir = path.join(__dirname, "audio_output");
    if (!fs.existsSync(audioDir)) {
      fs.mkdirSync(audioDir, { recursive: true });
    }
    const outputFile = path.join(audioDir, `voltvoice_inworld_${Date.now()}.mp3`);

    try {
      log(`Sintetizando con Inworld TTS: "${text.substring(0, 50)}..." (voz: ${voiceId})`);

      const requestBody = JSON.stringify({
        text: text,
        voiceId: voiceId,
        modelId: modelId
      });

      const options_req = {
        hostname: "api.inworld.ai",
        port: 443,
        path: "/tts/v1/voice:stream",
        method: "POST",
        headers: {
          "Authorization": `Basic ${apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(requestBody),
        },
      };

      const req = https.request(options_req, (res) => {
        const chunks = [];

        // Log headers para saber qué formato retorna
        log(`📋 Response headers:`, JSON.stringify(res.headers));
        log(`Content-Type: ${res.headers['content-type']}`);

        res.on("data", (chunk) => {
          chunks.push(chunk);
        });

        res.on("end", () => {
          try {
            if (res.statusCode !== 200) {
              const dataBuffer = Buffer.concat(chunks);
              const data = dataBuffer.toString("utf-8");
              log(`❌ Inworld API error: ${res.statusCode}`);
              log(`   Respuesta: ${data.substring(0, 300)}`);
              reject(new Error(`Inworld API error: ${res.statusCode} - ${data}`));
              return;
            }

            const dataBuffer = Buffer.concat(chunks);
            log(`✅ Inworld respuesta OK (${dataBuffer.length} bytes)`);

            // Debug: mostrar primeros 500 caracteres
            const preview = dataBuffer.toString("utf-8", 0, 500);
            log(`📝 Preview: ${preview.substring(0, 300)}...`);

            if (dataBuffer.length === 0) {
              log("Inworld: respuesta vacía");
              reject(new Error("Empty response from Inworld"));
              return;
            }

            // Parsear respuesta JSON (audioContent es base64 del MP3)
            let audioBuffer = null;

            try {
              const data = dataBuffer.toString("utf-8");

              // CRITICAL FIX: La respuesta contiene MÚLTIPLES audioContent fields (streaming chunks)
              // Extraer TODOS y decodificar cada uno por separado, luego concatenar el audio BINARIO
              const allMatches = data.match(/"audioContent"\s*:\s*"([^"]*(?:\\.[^"]*)*?)"/g) || [];
              log(`📊 Total audioContent fields found: ${allMatches.length}`);

              if (allMatches.length === 0) {
                log(`❌ No se encontró audioContent en respuesta`);
                log(`   Data preview: ${data.substring(0, 500)}`);
                reject(new Error("No audioContent found"));
                return;
              }

              // Decodificar CADA chunk por separado y concatenar como BINARIO
              const audioChunks = [];
              let totalBase64Length = 0;

              for (let i = 0; i < allMatches.length; i++) {
                const match = allMatches[i];
                const contentMatch = match.match(/"audioContent"\s*:\s*"([^"]*(?:\\.[^"]*)*?)"/);
                if (contentMatch && contentMatch[1]) {
                  const base64Content = contentMatch[1];
                  totalBase64Length += base64Content.length;

                  try {
                    // Decodificar este chunk individual
                    const chunk = Buffer.from(base64Content, "base64");
                    audioChunks.push(chunk);
                    log(`   Chunk ${i + 1}: ${base64Content.length} chars base64 -> ${chunk.length} bytes`);
                  } catch (e) {
                    log(`   ⚠️ Error decodificando chunk ${i + 1}: ${e.message}`);
                  }
                }
              }

              log(`✅ ${audioChunks.length} chunks decodificados exitosamente`);
              log(`   Total base64: ${totalBase64Length} caracteres`);

              // Concatenar todos los chunks binarios
              audioBuffer = Buffer.concat(audioChunks);
              log(`✅ Audio combinado: ${audioBuffer.length} bytes totales`);

              // Diagnostics
              const firstBytes = audioBuffer.slice(0, 20).toString('hex');
              const lastBytes = audioBuffer.slice(-20).toString('hex');
              log(`   Primeros 20 bytes (hex): ${firstBytes}`);
              log(`   Últimos 20 bytes (hex): ${lastBytes}`);

              // Verificar MP3 headers
              if (audioBuffer[0] === 0xFF && (audioBuffer[1] === 0xFB || audioBuffer[1] === 0xFA)) {
                log(`✅ Headers MPEG válidos detectados`);
              } else {
                log(`⚠️ No hay headers MPEG estándar (primeros bytes: ${audioBuffer[0]?.toString(16)}, ${audioBuffer[1]?.toString(16)})`);
              }

            } catch (parseError) {
              log(`❌ Error procesando respuesta: ${parseError.message}`);
              reject(new Error("Failed to process response"));
              return;
            }

            if (!audioBuffer || audioBuffer.length === 0) {
              log("❌ No hay audio para reproducir");
              reject(new Error("No audio content found"));
              return;
            }

            fs.writeFileSync(outputFile, audioBuffer);
            log(`✅ Archivo guardado: ${outputFile} (${audioBuffer.length} bytes)`);

            // Esperar un poco para asegurar que el archivo está completamente escrito
            setTimeout(() => {
              playAudio(outputFile).then(() => {
                // Esperar 2 segundos antes de borrar para asegurar que PowerShell terminó
                setTimeout(() => {
                  try {
                    if (fs.existsSync(outputFile)) {
                      fs.unlinkSync(outputFile);
                      log(`🗑️ Archivo temporal borrado`);
                    }
                  } catch (e) {
                    log("No se pudo eliminar archivo temporal:", e.message);
                  }
                }, 2000);
                resolve();
              }).catch(err => {
                log("Error reproduciendo audio Inworld:", err.message);
                reject(err);
              });
            }, 500);
          } catch (err) {
            log("Error procesando respuesta Inworld:", err.message);
            reject(err);
          }
        });
      });

      req.on("error", (err) => {
        log("Error en Inworld request:", err.message);
        reject(err);
      });

      log(`Enviando solicitud a Inworld con voiceId: ${voiceId}, modelId: ${modelId}`);
      req.write(requestBody);
      req.end();
    } catch (err) {
      log("Error en Inworld TTS:", err.message);
      reject(err);
    }
  });
}

// Reproducir con Windows TTS
function speakWindows(text, options = {}) {
  return new Promise((resolve, reject) => {
    const voiceName = options.voice ? options.voice.replace("windows_", "") : null;
    const rate = options.rate ? normalizeRate(options.rate) : null;

    // Convertir rate de WPM a PowerShell -10 a 10
    const psRate = rate !== null ? rate : 0;

    const lines = [
      "Add-Type -AssemblyName System.Speech",
      "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
      "$synth.SetOutputToDefaultAudioDevice()",
    ];

    if (psRate !== 0) {
      lines.push(`$synth.Rate = ${psRate}`);
    }

    if (voiceName) {
      const escaped = voiceName.replace(/'/g, "''");
      lines.push(
        `$match = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Name -match '${escaped}' } | Select-Object -First 1`,
        "if ($match) { $synth.SelectVoice($match.VoiceInfo.Name) }",
      );
    }

    const encodedText = Buffer.from(text, "utf16le").toString("base64");
    lines.push(
      `$text = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${encodedText}'))`,
      "$synth.Speak($text)",
    );

    const script = lines.join("; ");
    const ps = spawn("powershell", ["-NoProfile", "-Command", script], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      detached: false,
    });

    let stderr = "";
    ps.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ps.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`PowerShell exit code: ${code}`));
      } else {
        resolve();
      }
    });

    ps.on("error", (err) => {
      log("Error Windows TTS:", err.message);
      reject(err);
    });
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    // Endpoint para obtener voces disponibles
    if (req.method === "GET" && req.url === "/voices") {
      try {
        // === Voces clonadas personalizadas (primeras - las importantes) ===
        const customVoices = loadCustomVoices();
        const customVoicesList = Object.entries(customVoices).map(([name, voiceId]) => ({
          name: `inworld_custom_${name}`,
          displayName: `🎤 ${name.charAt(0).toUpperCase() + name.slice(1)} (clonada)`,
          voiceId: voiceId,
          type: "inworld_custom",
          isCustom: true,
        }));

        // === Voces estándar de Inworld TTS ===
        const inworldVoicesList = await getInworldVoices();
        const inworldVoices = inworldVoicesList.map(v => ({
          name: `inworld_${v.name.toLowerCase()}`,  // inworld_diego, inworld_lupita, etc.
          displayName: v.displayName,
          type: "inworld",
          gender: v.gender,
        }));

        // === Voces de Google TTS ===
        const googleVoices = GOOGLE_VOICES.map(v => ({
          name: `google_${v.name}`,
          culture: v.culture,
          type: "google",
        }));

        // === Voces de Windows ===
        const windowsVoices = await getWindowsVoices();

        // === Combinar todas en orden: custom clonadas → Inworld → Google → Windows ===
        const allVoices = [...customVoicesList, ...inworldVoices, ...googleVoices, ...windowsVoices];

        log(`📋 Voces disponibles: ${allVoices.map(v => v.name).join(", ")}`);
        send(res, 200, { voices: allVoices });
      } catch (err) {
        send(res, 500, { error: err.message });
      }
      return;
    }

    if (req.method !== "POST" || req.url !== "/say") {
      send(res, 404, { error: "ruta no encontrada" });
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!body) {
        send(res, 400, { error: "cuerpo vacío" });
        return;
      }

      let payload;
      try {
        payload = JSON.parse(body);
      } catch (err) {
        send(res, 400, { error: "JSON inválido" });
        return;
      }

      const text = (payload.text || "").trim();
      if (!text) {
        send(res, 400, { error: "texto requerido" });
        return;
      }

      const rate = Number.isFinite(payload.rate) ? payload.rate : undefined;
      const voice = typeof payload.voice === "string" ? payload.voice.trim() : undefined;

      const duration = estimateDuration(text, rate);

      // Determinar qué motor TTS usar basado en prefijo
      // Estrategia de fallback: Inworld → Google → Windows
      if (voice && voice.startsWith("inworld_")) {
        // Usar Inworld TTS con fallback a Google
        speakInworld(text, { voice })
          .catch((err) => {
            log("Inworld TTS falló, usando Google TTS como fallback:", err.message);
            return speak(text, { rate, voice });
          })
          .catch((err) => {
            log("Google TTS también falló, usando Windows TTS como fallback:", err.message);
            return speakWindows(text, { rate, voice });
          })
          .then(() => {
            log("Audio completado (%d caracteres, %dms).", text.length, duration);
            send(res, 200, { status: "ok", text, duration });
          })
          .catch((err) => {
            log("Error en todos los motores TTS:", err.message);
            send(res, 500, { error: "Error en TTS" });
          });
      } else if (voice && voice.startsWith("google_")) {
        // Usar Google TTS con fallback a Windows
        speak(text, { rate, voice })
          .catch((err) => {
            log("Google TTS falló, usando Windows TTS como fallback:", err.message);
            return speakWindows(text, { rate, voice });
          })
          .then(() => {
            log("Audio completado (%d caracteres, %dms).", text.length, duration);
            send(res, 200, { status: "ok", text, duration });
          })
          .catch((err) => {
            log("Error en TTS:", err.message);
            send(res, 500, { error: "Error en TTS" });
          });
      } else {
        // Usar Windows TTS por defecto
        speakWindows(text, { rate, voice })
          .then(() => {
            log("Audio completado con Windows (%d caracteres, %dms).", text.length, duration);
            send(res, 200, { status: "ok", text, duration });
          })
          .catch((err) => {
            log("Error en Windows TTS:", err.message);
            send(res, 500, { error: "Error en TTS" });
          });
      }
      log("Iniciando TTS (%d caracteres, ~%dms).", text.length, duration);
    });

    req.on("error", () => {
      send(res, 400, { error: "error en la conexión" });
    });
  });
}

function run(port = parseInt(process.env.PORT, 10) || 5002) {
  const server = createServer();
  server.listen(port, () => {
    log(`Servicio TTS escuchando en http://127.0.0.1:${port}/say`);
    log("Envía POST con {\"text\":\"hola\"} y opcionalmente rate/voice.");
  });
  return server;
}

if (require.main === module) {
  run();
}

module.exports = { run };
