import { createSdk, handleExampleError } from './shared.js';
import type { SchwabOwokit } from '../src/index.js';
import type { StreamerCommandResponse, StreamerDataPayload } from '../src/types/streamer.js';

const STREAM_PROBE_TIMEOUT_MS = 10_000;

interface StreamerProbeOptions {
  label: string;
  service: string;
  symbol: string;
  subscribe: () => void;
  timeoutMs?: number;
  dataLabel?: string;
}

interface StreamerProbeResult {
  status: 'data' | 'not_entitled' | 'timeout' | 'error';
  message: string;
  sampleData?: Array<Record<string, unknown>>;
  response?: StreamerCommandResponse;
  error?: unknown;
}

async function main(): Promise<void> {
  const sdk = createSdk();

  console.log('=== 开始诊断用户偏好设置 ===');

  try {
    console.log('正在获取用户偏好设置...');
    const userPreferences = await sdk.trader.getUserPreferences();

    console.log('用户偏好设置结构:');
    console.log(JSON.stringify(userPreferences, null, 2));

    const prefsArray = Array.isArray(userPreferences) ? userPreferences : [userPreferences];

    if (!prefsArray || prefsArray.length === 0) {
      console.error('❌ 用户偏好设置为空');
      return;
    }

    console.log(`\n✅ 获取到 ${prefsArray.length} 个用户偏好设置项`);

    for (let i = 0; i < prefsArray.length; i++) {
      const pref = prefsArray[i];
      console.log(`\n--- 偏好设置 ${i + 1} ---`);

      if (pref.accounts) {
        console.log(`✅ 账户数量: ${pref.accounts.length}`);
        pref.accounts.forEach((account, idx) => {
          console.log(`  账户 ${idx + 1}: ${account.accountNumber} (${account.type || 'Unknown'})`);
        });
      } else {
        console.log('❔ 无账户信息');
      }

      if (pref.streamerInfo) {
        console.log(`✅ StreamerInfo 数量: ${pref.streamerInfo.length}`);
        pref.streamerInfo.forEach((streamer, idx) => {
          console.log(`  Streamer ${idx + 1}:`);
          console.log(`    Socket URL: ${streamer.streamerSocketUrl}`);
          console.log(`    Customer ID: ${streamer.schwabClientCustomerId}`);
          console.log(`    Correlation ID: ${streamer.schwabClientCorrelId}`);
          console.log(`    Channel: ${streamer.schwabClientChannel}`);
          console.log(`    Function ID: ${streamer.schwabClientFunctionId}`);
        });
      } else {
        console.log('❔ 未提供 StreamerInfo');
      }

      if (pref.offers) {
        console.log(`✅ 权限信息数量: ${pref.offers.length}`);
        pref.offers.forEach((offer, idx) => {
          console.log(`  权限 ${idx + 1}:`);
          console.log(`    Level2 权限: ${offer.level2Permissions ? '是' : '否'}`);
          console.log(`    市场数据权限: ${offer.mktDataPermission || '未知'}`);
        });
      } else {
        console.log('❔ 无权限信息');
      }
    }

    const firstPref = prefsArray[0];
    const streamerInfo = firstPref?.streamerInfo?.[0];

    if (streamerInfo) {
      console.log('\n✅ 成功找到 StreamerInfo，可以进行流数据连接');

      const requiredFields = [
        'streamerSocketUrl',
        'schwabClientCustomerId',
        'schwabClientCorrelId',
        'schwabClientChannel',
        'schwabClientFunctionId',
      ];
      const missingFields = requiredFields.filter((field) => !streamerInfo[field as keyof typeof streamerInfo]);

      if (missingFields.length > 0) {
        console.warn(`⚠️ StreamerInfo 缺少必需字段: ${missingFields.join(', ')}`);
      } else {
        console.log('✅ StreamerInfo 所有必需字段都存在');
      }

      await runLevel2Probes(sdk);
    } else {
      console.error('\n❌ 未找到可用的 StreamerInfo');
      console.error('可能的原因:');
      console.error('1. 开发者应用程序尚未获得 Schwab 批准');
      console.error('2. 账户没有流数据权限');
      console.error('3. API 应用程序配置不完全');
      console.error('4. 需要联系 Schwab 开发者支持');
    }
  } catch (error) {
    console.error('获取用户偏好设置时发生错误:', error);
    if (error instanceof Error) {
      console.error('错误详情:', error.message);
      console.error('错误堆栈:', error.stack);
    }
  }

  console.log('\n=== 诊断完成 ===');
}

async function runLevel2Probes(sdk: SchwabOwokit): Promise<void> {
  console.log('\n=== 开始 Level 1 对照订阅 ===');

  const controlProbes: StreamerProbeOptions[] = [
    {
      label: 'Level 1 控制 (AAPL - LEVELONE_EQUITIES)',
      service: 'LEVELONE_EQUITIES',
      symbol: 'AAPL',
      dataLabel: 'Level 1 行情',
      subscribe: () => sdk.marketDataStream.subscribeLevelOneEquities({ keys: 'AAPL' }),
    },
  ];

  const level2Probes: StreamerProbeOptions[] = [
    {
      label: 'NYSE Level II (IBM)',
      service: 'NYSE_BOOK',
      symbol: 'IBM',
      dataLabel: 'Level II 档位数据',
      subscribe: () => sdk.marketDataStream.subscribeNyseBook({ keys: 'IBM' }),
    },
    {
      label: 'NASDAQ Level II (AAPL)',
      service: 'NASDAQ_BOOK',
      symbol: 'AAPL',
      dataLabel: 'Level II 档位数据',
      subscribe: () => sdk.marketDataStream.subscribeNasdaqBook({ keys: 'AAPL' }),
    },
  ];

  let connected = false;
  try {
    await sdk.connectStreamer();
    connected = true;

    for (const probe of controlProbes) {
      console.log(`\n▶ ${probe.label}`);
      await logProbeResult(await probeStreamerSubscription(sdk, probe));
    }

    console.log('\n=== 开始 Level 2 权限探测 ===');

    for (const probe of level2Probes) {
      console.log(`\n▶ ${probe.label}`);
      await logProbeResult(await probeStreamerSubscription(sdk, probe));
    }
  } catch (error) {
    console.error('Level 2 探测流程失败:', error);
  } finally {
    if (connected) {
      sdk.disconnectStreamer();
      console.log('\n已断开市场数据 Streamer');
    }
    console.log('\n=== Level 2 权限探测结束 ===');
  }
}

async function probeStreamerSubscription(
  sdk: SchwabOwokit,
  options: StreamerProbeOptions,
): Promise<StreamerProbeResult> {
  const { streamer } = sdk;
  const timeoutMs = options.timeoutMs ?? STREAM_PROBE_TIMEOUT_MS;

  console.log(`  -> 正在订阅 ${options.service}，代码 ${options.symbol}`);

  return await new Promise<StreamerProbeResult>((resolve) => {
    let settled = false;
    let subscriptionIssued = false;
    let latestResponse: StreamerCommandResponse | undefined;

    const cleanup = () => {
      streamer.off('response', onResponse);
      streamer.off('data', onData);
      streamer.off('error', onStreamerError);
      clearTimeout(timeoutHandle);

      if (subscriptionIssued && streamer.status !== 'disconnected') {
        try {
          streamer.unsubscribe({
            service: options.service,
            parameters: { keys: options.symbol },
          });
        } catch (error) {
          console.warn(`  -> 取消订阅 ${options.service} 时出现异常:`, error);
        }
      }
    };

    const settle = (result: StreamerProbeResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const onResponse = (resp: StreamerCommandResponse) => {
      if (resp.service !== options.service) {
        return;
      }

      latestResponse = resp;
      console.log(`  -> 收到响应: code=${resp.content.code}, msg=${resp.content.msg}`);

      if (resp.content.code !== 0) {
        settle({
          status: 'not_entitled',
          message: `订阅被拒绝 (code=${resp.content.code}): ${resp.content.msg}`,
          response: resp,
        });
      }
    };

    const onData = (payload: StreamerDataPayload) => {
      if (payload.service !== options.service) {
        return;
      }

      const rows = payload.content ?? [];
      if (rows.length === 0) {
        console.log('  -> 收到数据包但内容为空');
        return;
      }

      settle({
        status: 'data',
        message: `收到 ${rows.length} 条 ${options.dataLabel ?? '数据'}`,
        sampleData: rows.slice(0, Math.min(3, rows.length)),
        response: latestResponse,
      });
    };

    const onStreamerError = (error: Error) => {
      settle({
        status: 'error',
        message: `Streamer 返回错误: ${error.message}`,
        error,
        response: latestResponse,
      });
    };

    const timeoutHandle = setTimeout(() => {
      settle({
        status: 'timeout',
        message: `在 ${timeoutMs / 1000} 秒内未收到 ${options.service} 的 ${options.dataLabel ?? '数据'} 或拒绝响应，可能是市场休市或权限不足。`,
        response: latestResponse,
      });
    }, timeoutMs);

    streamer.on('response', onResponse);
    streamer.on('data', onData);
    streamer.on('error', onStreamerError);

    try {
      options.subscribe();
      subscriptionIssued = true;
    } catch (error) {
      settle({
        status: 'error',
        message: `下发订阅命令失败: ${error instanceof Error ? error.message : String(error)}`,
        error,
      });
    }
  });
}

async function logProbeResult(result: StreamerProbeResult): Promise<void> {
  switch (result.status) {
    case 'data': {
      console.log(`  ✅ ${result.message}`);
      if (result.sampleData && result.sampleData.length > 0) {
        console.log('  数据样例:');
        console.log(JSON.stringify(result.sampleData, null, 2));
      }
      break;
    }
    case 'not_entitled': {
      console.warn(`  ⚠️ ${result.message}`);
      break;
    }
    case 'timeout': {
      console.warn(`  ⏱️ ${result.message}`);
      if (result.response) {
        console.warn(`  最后一次响应: code=${result.response.content.code}, msg=${result.response.content.msg}`);
      }
      break;
    }
    case 'error':
    default: {
      console.error(`  ❌ ${result.message}`);
      if (result.error) {
        console.error('  详细错误:', result.error);
      }
      break;
    }
  }
}

main().catch(handleExampleError);
