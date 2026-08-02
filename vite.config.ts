import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import cesiumPlugin from "vite-plugin-cesium";
import { find } from "geo-tz";
import type { Plugin, PluginOption, ViteDevServer } from "vite";
import { resolveGoogleMapsSharedUrl } from "./server/googleMaps.ts";
import { resolveJapanesePlaceName } from "./server/placeGeocode.ts";
import { lookupGsiElevations, prefetchGsiTerrainAroundSubject } from "./server/gsiElevation.ts";
import { lookupGsiGeoidHeight } from "./server/gsiGeoid.ts";
import { lookupOsmSiteContexts } from "./server/osmSiteContext.ts";
import { runSpotSearchJob } from "./server/runSpotSearchJob.ts";
import type { SpotSearchJobUpdater } from "./server/runSpotSearchJob.ts";
import type {
  SerializedSpotPresetResult,
  SpotSearchJob,
  SpotSearchJobInput,
} from "./src/types/backgroundSearch.ts";

const cesium = cesiumPlugin as unknown as () => PluginOption;

/**
 * Vite の preview は configureServer を実行しないため、ローカル API が
 * 404 にならないよう同じ Connect ミドルウェアを preview にも登録する。
 */
function withLocalPreviewApi(plugin: Plugin): Plugin {
  const configureDevServer = plugin.configureServer;
  if (typeof configureDevServer !== "function") return plugin;
  return {
    ...plugin,
    configurePreviewServer(server) {
      return configureDevServer.call(
        this,
        server as unknown as ViteDevServer
      );
    },
  };
}

function localTimezoneApi(): Plugin {
  return {
    name: "ksg-local-timezone-api",
    configureServer(server) {
      server.middlewares.use("/api/timezone", (request, response) => {
        const url = new URL(request.url ?? "", "http://localhost");
        const latitude = Number(url.searchParams.get("latitude"));
        const longitude = Number(url.searchParams.get("longitude"));
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        if (
          !Number.isFinite(latitude) ||
          !Number.isFinite(longitude) ||
          latitude < -90 ||
          latitude > 90 ||
          longitude < -180 ||
          longitude > 180
        ) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: "緯度・経度が不正です" }));
          return;
        }
        const timeZone = find(latitude, longitude)[0];
        response.statusCode = timeZone ? 200 : 404;
        response.end(
          JSON.stringify(timeZone ? { timeZone } : { error: "タイムゾーンを特定できません" })
        );
      });
    },
  };
}

function localGoogleMapsApi(): Plugin {
  return {
    name: "ksg-local-google-maps-api",
    configureServer(server) {
      server.middlewares.use(
        "/api/resolve-google-maps",
        async (request, response) => {
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          if (request.method !== "POST") {
            response.statusCode = 405;
            response.end(JSON.stringify({ error: "POSTリクエストのみ利用できます" }));
            return;
          }
          try {
            let rawBody = "";
            for await (const chunk of request) {
              rawBody += chunk.toString();
              if (rawBody.length > 65_536) throw new Error("送信内容が大きすぎます");
            }
            const body = JSON.parse(rawBody) as { url?: unknown };
            if (typeof body.url !== "string") throw new Error("共有URLがありません");
            response.statusCode = 200;
            response.end(
              JSON.stringify(await resolveGoogleMapsSharedUrl(body.url))
            );
          } catch (error) {
            response.statusCode = 422;
            response.end(
              JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
              })
            );
          }
        }
      );
    },
  };
}

function localPlaceGeocodeApi(): Plugin {
  return {
    name: "ksg-local-place-geocode-api",
    configureServer(server) {
      server.middlewares.use("/api/geocode", async (request, response) => {
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.end(JSON.stringify({ error: "POSTリクエストのみ利用できます" }));
          return;
        }
        try {
          let rawBody = "";
          for await (const chunk of request) {
            rawBody += chunk.toString();
            if (rawBody.length > 65_536) throw new Error("送信内容が大きすぎます");
          }
          const body = JSON.parse(rawBody) as { query?: unknown };
          if (typeof body.query !== "string") throw new Error("スポット名がありません");
          response.statusCode = 200;
          response.end(JSON.stringify(await resolveJapanesePlaceName(body.query)));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          response.statusCode = message.includes("見つかりません") ? 404 : 422;
          response.end(JSON.stringify({ error: message }));
        }
      });
    },
  };
}

function localGsiElevationApi(): Plugin {
  return {
    name: "ksg-local-gsi-elevation-api",
    configureServer(server) {
      server.middlewares.use(
        "/api/spot-terrain-prefetch",
        async (request, response) => {
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          if (request.method !== "POST") {
            response.statusCode = 405;
            response.end(JSON.stringify({ error: "POSTリクエストのみ利用できます" }));
            return;
          }
          try {
            let rawBody = "";
            for await (const chunk of request) rawBody += chunk.toString();
            const body = JSON.parse(rawBody) as { latitude?: unknown; longitude?: unknown; maximumDistanceMeters?: unknown };
            const latitude = Number(body.latitude);
            const longitude = Number(body.longitude);
            const maximumDistanceMeters = Math.max(500, Math.min(50_000, Number(body.maximumDistanceMeters) || 10_000));
            const result = await prefetchGsiTerrainAroundSubject(latitude, longitude, maximumDistanceMeters);
            response.statusCode = 200;
            response.end(JSON.stringify(result));
          } catch (error) {
            response.statusCode = 422;
            response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
          }
        }
      );

      server.middlewares.use(
        "/api/gsi-elevation",
        async (request, response) => {
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          if (request.method !== "POST") {
            response.statusCode = 405;
            response.end(JSON.stringify({ error: "POSTリクエストのみ利用できます" }));
            return;
          }
          try {
            let rawBody = "";
            for await (const chunk of request) {
              rawBody += chunk.toString();
              if (rawBody.length > 262_144) throw new Error("送信内容が大きすぎます");
            }
            const body = JSON.parse(rawBody) as {
              points?: Array<{
                latitude?: unknown;
                longitude?: unknown;
                maximumDetail?: unknown;
              }>;
            };
            if (!Array.isArray(body.points)) throw new Error("座標配列がありません");
            const points = body.points.map((point) => {
              const maximumDetail: "1m" | "5m" | "10m" | undefined =
                point.maximumDetail === "1m" ||
                point.maximumDetail === "5m" ||
                point.maximumDetail === "10m"
                  ? point.maximumDetail
                  : undefined;
              return {
                latitude: Number(point.latitude),
                longitude: Number(point.longitude),
                maximumDetail,
              };
            });
            response.statusCode = 200;
            response.end(JSON.stringify({ samples: await lookupGsiElevations(points) }));
          } catch (error) {
            response.statusCode = 422;
            response.end(JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            }));
          }
        }
      );
    },
  };
}

function localGsiGeoidApi(): Plugin {
  return {
    name: "ksg-local-gsi-geoid-api",
    configureServer(server) {
      server.middlewares.use("/api/gsi-geoid", async (request, response) => {
        const url = new URL(request.url ?? "", "http://localhost");
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        try {
          const geoidHeightMeters = await lookupGsiGeoidHeight(
            Number(url.searchParams.get("latitude")),
            Number(url.searchParams.get("longitude")),
            undefined,
            url.searchParams.get("precision") === "point"
          );
          response.statusCode = 200;
          response.end(JSON.stringify({ geoidHeightMeters }));
        } catch (error) {
          response.statusCode = 422;
          response.end(JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      });
    },
  };
}

function localOsmSiteContextApi(): Plugin {
  return {
    name: "ksg-local-osm-site-context-api",
    configureServer(server) {
      server.middlewares.use(
        "/api/osm-site-context",
        async (request, response) => {
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          if (request.method !== "POST") {
            response.statusCode = 405;
            response.end(JSON.stringify({ error: "POSTリクエストのみ利用できます" }));
            return;
          }
          try {
            let rawBody = "";
            for await (const chunk of request) {
              rawBody += chunk.toString();
              if (rawBody.length > 65_536) throw new Error("送信内容が大きすぎます");
            }
            const body = JSON.parse(rawBody) as {
              points?: Array<{ latitude?: unknown; longitude?: unknown }>;
              includeDetails?: unknown;
            };
            if (!Array.isArray(body.points)) throw new Error("候補座標がありません");
            const points = body.points.map((point) => ({
              latitude: Number(point.latitude),
              longitude: Number(point.longitude),
            }));
            response.statusCode = 200;
            response.end(JSON.stringify({
              contexts: await lookupOsmSiteContexts(
                points,
                undefined,
                body.includeDetails !== false
              ),
              attribution: "© OpenStreetMap contributors / 国土地理院 標高タイル",
            }));
          } catch (error) {
            response.statusCode = 422;
            response.end(JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            }));
          }
        }
      );
    },
  };
}

function localBackgroundSpotSearchApi(): Plugin {
  const jobs = new Map<string, SpotSearchJob>();
  const key = (clientId: string, jobId: string) => `${clientId}/${jobId}`;
  const updateJob: SpotSearchJobUpdater = async (clientId, jobId, update) => {
    const current = jobs.get(key(clientId, jobId));
    if (!current) throw new Error("検索ジョブが見つかりません");
    const next: SpotSearchJob = {
      ...current,
      ...update,
      updatedAt: new Date().toISOString(),
    };
    jobs.set(key(clientId, jobId), next);
    return next;
  };

  async function readBody(request: NodeJS.ReadableStream): Promise<unknown> {
    let rawBody = "";
    for await (const chunk of request) {
      rawBody += chunk.toString();
      if (rawBody.length > 1_048_576) throw new Error("送信内容が大きすぎます");
    }
    return JSON.parse(rawBody);
  }

  return {
    name: "ksg-local-background-spot-search-api",
    configureServer(server) {
      server.middlewares.use("/api/spot-search-start", async (request, response) => {
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        try {
          const body = await readBody(request) as {
            clientId?: unknown;
            jobId?: unknown;
            input?: unknown;
          };
          if (typeof body.clientId !== "string" || typeof body.jobId !== "string" ||
            typeof body.input !== "object" || body.input === null) {
            throw new Error("バックグラウンド検索条件が不正です");
          }
          const now = new Date().toISOString();
          const job: SpotSearchJob = {
            version: 1,
            clientId: body.clientId,
            jobId: body.jobId,
            status: "queued",
            progress: "バックグラウンド検索を開始しています…",
            input: body.input as SpotSearchJobInput,
            results: [],
            createdAt: now,
            updatedAt: now,
          };
          jobs.set(key(job.clientId, job.jobId), job);
          response.statusCode = 202;
          response.end(JSON.stringify({ jobId: job.jobId, status: "queued" }));
          setTimeout(() => {
            void runSpotSearchJob(job, updateJob).catch(async (error: unknown) => {
              await updateJob(job.clientId, job.jobId, {
                status: "failed",
                progress: "検索に失敗しました",
                error: error instanceof Error ? error.message : String(error),
              });
            });
          }, 0);
        } catch (error) {
          response.statusCode = 422;
          response.end(JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      });

      server.middlewares.use("/api/spot-search-status", (request, response) => {
        const url = new URL(request.url ?? "", "http://localhost");
        const clientId = url.searchParams.get("clientId") ?? "";
        const jobId = url.searchParams.get("jobId") ?? "";
        const job = jobs.get(key(clientId, jobId));
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.statusCode = job ? 200 : 404;
        response.end(JSON.stringify(job ?? { error: "検索ジョブが見つかりません" }));
      });

      server.middlewares.use("/api/spot-search-finalize", async (request, response) => {
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        try {
          const body = await readBody(request) as {
            clientId?: unknown;
            jobId?: unknown;
            results?: unknown;
          };
          if (typeof body.clientId !== "string" || typeof body.jobId !== "string" ||
            !Array.isArray(body.results)) {
            throw new Error("最終3D確認結果が不正です");
          }
          const job = await updateJob(body.clientId, body.jobId, {
            status: "complete",
            progress: "検索が完了しました",
            results: body.results as SerializedSpotPresetResult[],
            error: undefined,
          });
          response.statusCode = 200;
          response.end(JSON.stringify(job));
        } catch (error) {
          response.statusCode = 422;
          response.end(JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      });
    },
  };
}

export default defineConfig(({ command }) => {
  return {
    server: {
      // ヘッドレス確認用プロファイルとnpmキャッシュのロックファイルを監視しない。
      watch: {
        ignored: [
          "**/.edge-*/**",
          "**/.chrome-*/**",
          "**/.npm-cache/**",
          "**/.wrangler/**",
        ],
      },
    },
    plugins: [
      react(),
      cesium(),
      ...(command === "serve"
        ? [
            withLocalPreviewApi(localTimezoneApi()),
            withLocalPreviewApi(localGoogleMapsApi()),
            withLocalPreviewApi(localPlaceGeocodeApi()),
            withLocalPreviewApi(localGsiElevationApi()),
            withLocalPreviewApi(localGsiGeoidApi()),
            withLocalPreviewApi(localOsmSiteContextApi()),
            withLocalPreviewApi(localBackgroundSpotSearchApi()),
          ]
        : []),
      // ローカルの npm.cmd run dev では .netlify の監視を起動しません。
    ],
  };
});
