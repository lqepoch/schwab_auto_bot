# Schwab API 调试工具使用指南

## 概述

为了提高调试效率并减少 examples 代码的容量，我们将调试功能从 examples 中迁移到了 src 中，并提供了强大的调试工具库。这些工具现在作为 npm 包的一部分公开发布，方便开发者在生产环境中使用。

## 核心调试工具

### 1. StreamerDebugger - 全功能流数据调试器

最高级的调试工具，提供全面的 Streamer 监控和分析功能。

```typescript
import { createStreamerDebugger } from 'schwab-api-nodejs';

const debugger = createStreamerDebugger({
  verbose: true,                    // 启用详细日志
  showRawData: true,               // 显示原始数据
  autoAnalyze: true,               // 自动数据质量分析
  enableVisualization: true,       // 启用ASCII图表可视化
  enablePerformanceMonitoring: true, // 性能监控
  statisticsInterval: 30000,       // 统计信息打印间隔
  saveToFile: false               // 保存日志到文件
});

// 启动监控
debugger.startMonitoring(sdk.streamer);

// 获取诊断报告
const report = debugger.getDiagnosticReport();
```

### 2. 快速调试器

为简单使用场景提供的快捷方式：

```typescript
import { createQuickDebugger } from 'schwab-api-nodejs';

// 基础调试
const debugger = createQuickDebugger(false);

// 详细调试
const verboseDebugger = createQuickDebugger(true);

debugger.startMonitoring(sdk.streamer);
```

### 3. 数据解析和可视化工具

#### 数据解析器

```typescript
import { 
  parseLevelOneEquities, 
  parseNasdaqBook, 
  parseChartEquity 
} from 'schwab-api-nodejs';

// 解析 Level 1 数据
const level1Info = parseLevelOneEquities(item);
console.log(level1Info);

// 解析 Level II Book 数据
const bookInfo = parseNasdaqBook(item);
console.log(bookInfo);
```

#### 数据可视化

```typescript
import { DataVisualizer } from 'schwab-api-nodejs';

// 创建价格走势图
const priceChart = DataVisualizer.createPriceChart(prices, 50, 10);
console.log(priceChart);

// 创建成交量柱状图
const volumeChart = DataVisualizer.createVolumeChart(volumes, 50, 5);
console.log(volumeChart);

// 创建买卖盘深度可视化
const bookVisualization = DataVisualizer.createBookVisualization(
  bidLevels, 
  askLevels, 
  10
);
console.log(bookVisualization);
```

### 4. 连接状态监控

```typescript
import { ConnectionMonitor, DebugLogger } from 'schwab-api-nodejs';

const logger = new DebugLogger({ scope: 'MyApp' });
const monitor = new ConnectionMonitor(logger);

// 记录连接事件
monitor.recordEvent('connected');
monitor.recordEvent('disconnected', 'Network error');

// 获取连接统计
const stats = monitor.getConnectionStats();
monitor.printConnectionStats();
```

### 5. 性能监控

```typescript
import { PerformanceMonitor } from 'schwab-api-nodejs';

const perfMonitor = new PerformanceMonitor();

// 测量同步函数
const result = perfMonitor.measureTime('dataProcessing', () => {
  // 您的处理逻辑
  return processData(data);
});

// 测量异步函数
const asyncResult = await perfMonitor.measureTimeAsync('apiCall', async () => {
  return await sdk.marketData.getQuotes({ symbols: ['AAPL'] });
});

// 获取性能统计
perfMonitor.printPerformanceStats();
```

### 6. 增强日志记录

```typescript
import { DebugLogger } from 'schwab-api-nodejs';

const logger = new DebugLogger({ scope: 'Trading' });

// 设置调试上下文
logger.setContext('sessionId', 'abc123');
logger.setContext('userId', 'user456');

// 记录 API 调用
logger.logApiCall('GET', '/marketdata/quotes', { symbols: 'AAPL' }, 150.5);

// 记录数据质量问题
logger.logDataQuality('LEVELONE_EQUITIES', 'AAPL', 0.75, ['missing bid price']);

// 记录性能指标
logger.logPerformanceMetric('dataProcessing', 25.5, 50);

// 记录连接状态
logger.logConnectionStatus('connected', { endpoint: 'wss://...' });
```

## 环境变量配置

通过环境变量控制调试行为：

```bash
# 启用详细的 Streamer 调试
DEBUG_STREAMER=true

# 启用字段详情显示
DEBUG_FIELDS=true

# 显示原始数据
DEBUG_RAW=true

# 保存调试日志到文件
SAVE_LOG=true
```

## 在 Examples 中的使用

所有复杂的 examples 已经简化，现在使用统一的调试工具：

### 多数据源监控示例

```typescript
// examples/stream-multi-data-sources.ts
import { createQuickDebugger } from '../src/index.js';

const streamDebugger = createQuickDebugger(process.env.DEBUG_STREAMER === 'true');
await sdk.connectStreamer();
streamDebugger.startMonitoring(sdk.streamer);

// 自动获得：
// - 实时数据统计
// - 数据质量分析
// - 连接状态监控
// - 性能指标
// - 问题诊断
```

### Level II 调试示例

```typescript
// examples/debug-level2-detailed.ts
import { createStreamerDebugger } from '../src/index.js';

const streamDebugger = createStreamerDebugger({
  verbose: true,
  showRawData: true,
  autoAnalyze: true,
  enableVisualization: true,
  enablePerformanceMonitoring: true,
  statisticsInterval: 30000
});

streamDebugger.startMonitoring(sdk.streamer);

// 提供详细的 Level II 数据分析和可视化
```

## 字段定义和映射

使用预定义的字段映射来理解数据结构：

```typescript
import { 
  LEVELONE_EQUITIES_FIELDS,
  NASDAQ_BOOK_FIELDS,
  CHART_EQUITY_FIELDS,
  getFieldDefinition
} from 'schwab-api-nodejs';

// 获取字段定义
const fieldDef = getFieldDefinition('LEVELONE_EQUITIES', '1');
console.log(fieldDef); // { name: 'Bid Price', type: 'double', description: '...' }

// 查看所有支持的字段
console.log(LEVELONE_EQUITIES_FIELDS);
```

## 数据质量评估

自动评估数据质量并提供改进建议：

```typescript
import { validateStreamData } from 'schwab-api-nodejs';

// 验证流数据
const isValid = validateStreamData(payload.content, 'LEVELONE_EQUITIES');

// StreamerDebugger 会自动：
// - 检测缺失字段
// - 评估数据完整性
// - 识别常见问题
// - 提供解决建议
```

## 最佳实践

1. **开发阶段**：使用 `createStreamerDebugger` 的详细模式
2. **测试阶段**：使用 `createQuickDebugger` 进行基础监控
3. **生产阶段**：只启用必要的监控，关闭详细日志
4. **问题诊断**：启用所有调试功能，包括原始数据显示
5. **性能优化**：使用 `PerformanceMonitor` 识别瓶颈

## 迁移指南

### 从旧的 examples 代码迁移

**之前**：
```typescript
// 大量重复的调试代码
sdk.streamer.on('data', (payload) => {
  console.log('收到数据:', payload.service);
  // 50+ 行调试代码
});

sdk.streamer.on('response', (payload) => {
  // 复杂的响应处理
});

// 手动统计和分析
```

**现在**：
```typescript
// 简洁的调试设置
const debugger = createStreamerDebugger({ verbose: true });
debugger.startMonitoring(sdk.streamer);

// 自动获得所有调试功能
```

### 自定义调试需求

```typescript
// 创建自定义调试器
const customDebugger = createStreamerDebugger({
  verbose: false,
  showRawData: false,
  autoAnalyze: true,
  enableVisualization: false,
  enablePerformanceMonitoring: true,
  statisticsInterval: 60000
});

// 只监控特定事件
customDebugger.startMonitoring(sdk.streamer);
```

## 故障排除

### 常见问题

1. **数据质量低**：检查订阅权限和市场状态
2. **连接频繁断开**：检查网络稳定性和心跳配置
3. **性能问题**：使用性能监控器识别瓶颈
4. **字段缺失**：参考字段定义文档

### 获取帮助

1. 查看诊断报告：`debugger.getDiagnosticReport()`
2. 启用详细日志：设置 `verbose: true`
3. 检查原始数据：设置 `showRawData: true`
4. 查看性能统计：调用 `printPerformanceStats()`

这些工具将帮助您更高效地开发和调试 Schwab API 应用程序！
