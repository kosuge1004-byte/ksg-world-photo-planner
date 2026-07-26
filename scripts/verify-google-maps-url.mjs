import assert from "node:assert/strict";

import {
  extractGoogleMapsCoordinates,
  extractGoogleMapsSharedUrl,
} from "../src/search/googleMapsUrl.ts";
import {
  resolveGoogleMapsSharedUrlNatively,
} from "../src/search/nativeGoogleMapsResolver.ts";

const expected = {
  latitude: 35.4339171,
  longitude: 136.782051,
};

const directCases = [
  "https://maps.google.com/?q=35.4339171,136.782051",
  "https://www.google.com/maps/search/?api=1&query=35.4339171%2C136.782051",
  "https://www.google.com/maps/place/%E5%B2%90%E9%98%9C%E5%9F%8E/@35.4339171,136.782051,17z",
  "https://www.google.com/maps/place/%E5%B2%90%E9%98%9C%E5%9F%8E/data=!4m6!3m5!1s0x0:0x0!8m2!3d35.4339171!4d136.782051",
];

for (const url of directCases) {
  assert.deepEqual(extractGoogleMapsCoordinates(url), expected);
}

assert.equal(
  extractGoogleMapsSharedUrl(
    "岐阜城はこちら https://maps.app.goo.gl/7Xtp3LoZpuDc5Rqe7）。"
  ),
  "https://maps.app.goo.gl/7Xtp3LoZpuDc5Rqe7"
);

const shortUrl = "https://maps.app.goo.gl/7Xtp3LoZpuDc5Rqe7";
const resolvedUrl =
  "https://www.google.com/maps/place/%E5%B2%90%E9%98%9C%E5%9F%8E/@35.4339171,136.782051,17z";
const automaticResult = await resolveGoogleMapsSharedUrlNatively(
  shortUrl,
  undefined,
  async (_url, disableRedirects) => {
    assert.equal(disableRedirects, false);
    return {
      data: "",
      headers: {},
      status: 200,
      url: resolvedUrl,
    };
  }
);
assert.deepEqual(automaticResult, {
  ...expected,
  resolvedUrl,
});

let requestCount = 0;
const manualResult = await resolveGoogleMapsSharedUrlNatively(
  shortUrl,
  undefined,
  async (url, disableRedirects) => {
    requestCount += 1;
    if (!disableRedirects) throw new Error("自動転送を模擬的に失敗させる");
    if (url === shortUrl) {
      return {
        data: "",
        headers: { Location: resolvedUrl },
        status: 302,
        url,
      };
    }
    return {
      data: `APP_INITIALIZATION_STATE=[[null,null,${expected.latitude},${expected.longitude}]]`,
      headers: {},
      status: 200,
      url,
    };
  }
);
assert.deepEqual(manualResult, {
  ...expected,
  resolvedUrl,
});
assert.equal(requestCount, 3);

console.log(
  JSON.stringify({
    directAddressCases: directCases.length,
    shortUrlAutomaticRedirect: true,
    shortUrlManualRedirect: true,
  })
);
