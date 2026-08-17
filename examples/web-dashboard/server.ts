import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { createSdk } from '../shared.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Web Dashboard服务器 - 提供ECharts可视化界面
 * 实时推送Schwab API的股票数据到Web前端
 */
class StockDataServer {
  private app: express.Application;
  private server: any;
  private io: SocketIOServer;
  private sdk: any;
  private port = 3000;
  private demoMode = false;
  
  // 数据存储
  private stockData: Map<string, any> = new Map();
  private priceHistory: Map<string, Array<{time: number, price: number, volume: number}>> = new Map();
  private connectionStats = {
    startTime: Date.now(),
    dataCount: 0,
    connectedClients: 0,
    lastUpdate: Date.now()
  };

  constructor() {
    this.app = express();
    this.server = createServer(this.app);
    this.io = new SocketIOServer(this.server, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      }
    });
    
    this.setupExpress();
    this.setupSocketIO();
    this.setupSchwabAPI();
  }

  private setupExpress() {
    // 静态文件服务
    this.app.use(express.static(path.join(__dirname, 'public')));
    
    // API路由
    this.app.get('/api/stats', (req, res) => {
      res.json({
        ...this.connectionStats,
        uptime: Date.now() - this.connectionStats.startTime,
        stockCount: this.stockData.size
      });
    });

    this.app.get('/api/stocks', (req, res) => {
      const stocks = Array.from(this.stockData.entries()).map(([symbol, data]) => ({
        symbol,
        ...data,
        history: this.priceHistory.get(symbol)?.slice(-100) || [] // 最近100个数据点
      }));
      res.json(stocks);
    });

    // 主页路由
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    // 专业版界面路由
    this.app.get('/pro', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'professional.html'));
    });
  }

  private setupSocketIO() {
    this.io.on('connection', (socket) => {
      this.connectionStats.connectedClients++;
      console.log(`🔌 客户端连接: ${socket.id} (总计: ${this.connectionStats.connectedClients})`);
      
      // 发送当前数据
      socket.emit('initialData', {
        stocks: Array.from(this.stockData.entries()),
        stats: this.connectionStats
      });

      socket.on('disconnect', () => {
        this.connectionStats.connectedClients--;
        console.log(`🔌 客户端断开: ${socket.id} (剩余: ${this.connectionStats.connectedClients})`);
      });

      socket.on('subscribe', (symbols: string[]) => {
        console.log(`📊 客户端请求订阅: ${symbols.join(', ')}`);
        // 这里可以动态订阅新的股票
      });
    });
  }

  private async setupSchwabAPI() {
    try {
      this.sdk = createSdk({
        streamer: {
          autoReconnect: true,
          reconnectDelayMs: 3_000,
          heartbeatTimeoutMs: 30_000,
          heartbeatCheckIntervalMs: 10_000
        },
        httpTimeoutMs: 20_000
      });

      await this.sdk.connectStreamer();
      console.log('✅ Schwab API连接成功');
      this.demoMode = false;
    } catch (error) {
      console.warn('⚠️  Schwab API连接失败，启动演示模式:', error instanceof Error ? error.message : String(error));
      this.demoMode = true;
      this.startDemoMode();
      return;
    }

    // 监听数据
    this.sdk.streamer.on('data', (payload: any) => {
      if (payload.service === 'LEVELONE_EQUITIES') {
        this.handleLevelOneData(payload.content);
      } else if (payload.service === 'NASDAQ_BOOK' || payload.service === 'NYSE_BOOK') {
        this.handleLevel2Data(payload.service, payload.content);
      } else if (payload.service === 'CHART_EQUITY') {
        this.handleChartData(payload.content);
      }
    });

    this.sdk.streamer.on('ready', () => {
      console.log('🟢 Schwab Streamer就绪');
      this.io.emit('connectionStatus', { status: 'connected', message: 'Schwab API已连接' });
    });

    this.sdk.streamer.on('disconnected', () => {
      console.log('🔴 Schwab Streamer断开');
      this.io.emit('connectionStatus', { status: 'disconnected', message: 'Schwab API已断开' });
    });

    this.sdk.streamer.on('error', (error: any) => {
      console.error('❌ Schwab Streamer错误:', error.message);
      this.io.emit('connectionStatus', { status: 'error', message: error.message });
    });

    // 订阅默认股票
    const defaultSymbols = ['QQQ', 'SPY', 'AAPL', 'TSLA', 'NVDA'];
    this.subscribeToSymbols(defaultSymbols);
    this.subscribeToLevel2Data(defaultSymbols);
  }

  private handleLevelOneData(content: any[]) {
    if (!Array.isArray(content)) return;

    content.forEach(item => {
      const symbol = item.key;
      if (!symbol) return;

      const now = Date.now();
      
      // 获取原始数据
      const rawPrice = item['1']; // 最新价
      const rawVolume = item['8']; // 累计成交量
      const rawChange = item['18']; // 涨跌额
      const rawChangePercent = item['42']; // 涨跌百分比
      const rawBid = item['2']; // 买一价
      const rawAsk = item['3']; // 卖一价
      const rawHigh = item['12']; // 最高价
      const rawLow = item['13']; // 最低价
      const rawOpen = item['33']; // 开盘价

      // 获取现有数据作为fallback
      const existingData = this.stockData.get(symbol);
      
      // 智能数据合并 - 优先使用新数据，如果为空则保持原有数据
      const price = this.getValidValue(rawPrice, existingData?.price);
      const volume = this.getValidValue(rawVolume, existingData?.volume);
      const change = this.getValidValue(rawChange, existingData?.change);
      const changePercent = this.getValidValue(rawChangePercent, existingData?.changePercent);
      const bid = this.getValidValue(rawBid, existingData?.bid);
      const ask = this.getValidValue(rawAsk, existingData?.ask);
      const high = this.getValidValue(rawHigh, existingData?.high);
      const low = this.getValidValue(rawLow, existingData?.low);
      const open = this.getValidValue(rawOpen, existingData?.open);

      // 如果价格仍然无效，尝试从买卖价推算
      const finalPrice = this.calculateFallbackPrice(price, bid, ask, existingData?.price);

      // 数据质量检查
      const dataQuality = this.assessDataQuality(item);
      
      // 更新股票数据
      const stockInfo = {
        symbol,
        price: finalPrice,
        volume,
        change,
        changePercent,
        bid,
        ask,
        high,
        low,
        open,
        timestamp: now,
        updateTime: new Date(now).toLocaleString('zh-CN'),
        dataQuality, // 添加数据质量指标
        lastValidUpdate: finalPrice !== undefined ? now : (existingData?.lastValidUpdate || now)
      };

      this.stockData.set(symbol, stockInfo);
      
      // 记录数据问题
      if (dataQuality < 0.7) {
        console.warn(`⚠️  ${symbol} 数据质量较低 (${Math.round(dataQuality * 100)}%):`, {
          price: rawPrice,
          bid: rawBid,
          ask: rawAsk,
          receivedFields: Object.keys(item).filter(k => k !== 'key').join(',')
        });
      }

      // 更新价格历史
      if (price !== undefined) {
        if (!this.priceHistory.has(symbol)) {
          this.priceHistory.set(symbol, []);
        }
        
        const history = this.priceHistory.get(symbol)!;
        history.push({ time: now, price, volume: volume || 0 });
        
        // 保持最近1000个数据点
        if (history.length > 1000) {
          history.shift();
        }
      }

      // 发送到客户端
      this.io.emit('stockUpdate', stockInfo);
      this.connectionStats.dataCount++;
      this.connectionStats.lastUpdate = now;
    });
  }

  private subscribeToSymbols(symbols: string[]) {
    console.log(`📊 订阅股票: ${symbols.join(', ')}`);
    this.sdk.marketDataStream.subscribeLevelOneEquities({
      keys: symbols.join(','),
      fields: '0,1,2,3,4,5,8,9,12,13,18,33,42'
    });
  }

  private subscribeToLevel2Data(symbols: string[]) {
    console.log(`📚 订阅Level II数据: ${symbols.join(', ')}`);
    // 尝试订阅NASDAQ Book数据
    try {
      this.sdk.marketDataStream.subscribeNasdaqBook({
        keys: symbols.join(','),
        fields: '0,1,2,3'
      });
    } catch (error) {
      console.log('NASDAQ Book订阅失败，尝试NYSE Book');
      try {
        this.sdk.marketDataStream.subscribeNyseBook({
          keys: symbols.join(','),
          fields: '0,1,2,3'
        });
      } catch (error2) {
        console.log('Level II数据订阅失败，可能需要特殊权限');
      }
    }
  }

  /**
   * 获取有效值，优先使用新值，如果无效则使用旧值
   */
  private getValidValue(newValue: any, oldValue: any): any {
    if (newValue !== undefined && newValue !== null && newValue !== '') {
      return newValue;
    }
    return oldValue;
  }

  /**
   * 计算备用价格 - 当主价格无效时使用买卖价中点
   */
  private calculateFallbackPrice(price: number | undefined, bid: number | undefined, ask: number | undefined, lastPrice: number | undefined): number | undefined {
    // 如果有有效价格，直接返回
    if (price !== undefined && price > 0) {
      return price;
    }

    // 尝试使用买卖价中点
    if (bid !== undefined && ask !== undefined && bid > 0 && ask > 0) {
      const midPrice = (bid + ask) / 2;
      console.log(`📊 使用买卖价中点作为备用价格: (${bid} + ${ask}) / 2 = ${midPrice}`);
      return midPrice;
    }

    // 使用上次有效价格
    if (lastPrice !== undefined && lastPrice > 0) {
      console.log(`📊 使用上次有效价格: ${lastPrice}`);
      return lastPrice;
    }

    return undefined;
  }

  /**
   * 评估数据质量 (0-1之间，1表示完美)
   */
  private assessDataQuality(item: any): number {
    const expectedFields = ['1', '2', '3', '8', '18', '33', '42']; // 关键字段
    let validFields = 0;
    let totalFields = expectedFields.length;

    expectedFields.forEach(field => {
      const value = item[field];
      if (value !== undefined && value !== null && value !== '') {
        validFields++;
      }
    });

    return validFields / totalFields;
  }

  /**
   * 从Level I数据生成简化的Level II买卖盘
   */
  private generateMockLevel2FromLevel1(stockData: any, side: 'bid' | 'ask'): any[] {
    const levels = [];
    const basePrice = side === 'bid' ? stockData.bid : stockData.ask;
    
    if (!basePrice || basePrice <= 0) return [];

    // 生成5层买卖盘数据
    for (let i = 0; i < 5; i++) {
      const priceOffset = side === 'bid' ? -i * 0.01 : i * 0.01;
      const price = (basePrice + priceOffset);
      const size = Math.floor(Math.random() * 1000) + 100; // 随机数量
      
      levels.push({
        level: i + 1,
        price: price,
        size: size,
        marketMakers: Math.floor(Math.random() * 5) + 1,
        details: [],
        isGenerated: true // 标记为生成的数据
      });
    }
    
    return levels;
  }

  /**
   * 启动演示模式
   */
  private startDemoMode() {
    console.log('🎭 演示模式已启动 - 生成模拟Level II数据');
    
    const symbols = ['QQQ', 'AAPL', 'NVDA', 'TSLA', 'SPY'];
    const basePrices: Record<string, number> = {
      'QQQ': 597.90,
      'AAPL': 221.50,
      'NVDA': 116.80,
      'TSLA': 240.30,
      'SPY': 662.25
    };
    
    // 初始化股票数据
    symbols.forEach(symbol => {
      const basePrice = basePrices[symbol];
      this.stockData.set(symbol, {
        symbol,
        price: basePrice,
        bid: basePrice - 0.01,
        ask: basePrice + 0.01,
        volume: Math.floor(Math.random() * 1000000) + 100000,
        change: (Math.random() - 0.5) * 10,
        changePercent: (Math.random() - 0.5) * 2,
        dataQuality: 1.0,
        timestamp: Date.now()
      });
    });

    // 定期更新数据
    setInterval(() => {
      symbols.forEach(symbol => {
        this.updateDemoStock(symbol);
        this.generateDemoLevel2Data(symbol);
        this.generateDemoChartData(symbol);
      });
    }, 1000);
  }

  /**
   * 更新演示股票数据
   */
  private updateDemoStock(symbol: string) {
    const stock = this.stockData.get(symbol);
    if (!stock) return;

    // 随机价格波动
    const priceChange = (Math.random() - 0.5) * 0.1;
    stock.price += priceChange;
    stock.bid = stock.price - 0.01;
    stock.ask = stock.price + 0.01;
    stock.change += priceChange;
    stock.changePercent = (stock.change / (stock.price - stock.change)) * 100;
    stock.volume += Math.floor(Math.random() * 1000);
    stock.timestamp = Date.now();

    this.io.emit('stockUpdate', stock);
  }

  /**
   * 生成演示Level II数据
   */
  private generateDemoLevel2Data(symbol: string) {
    const stock = this.stockData.get(symbol);
    if (!stock) return;

    const bidLevels = [];
    const askLevels = [];
    
    // 生成10层买卖盘
    for (let i = 0; i < 10; i++) {
      bidLevels.push({
        level: i + 1,
        price: stock.bid - (i * 0.01),
        size: Math.floor(Math.random() * 2000) + 100,
        marketMakers: Math.floor(Math.random() * 5) + 1,
        details: [`ARCA`, `NSDQ`, `NYSE`][Math.floor(Math.random() * 3)],
        isGenerated: true
      });
      
      askLevels.push({
        level: i + 1,
        price: stock.ask + (i * 0.01),
        size: Math.floor(Math.random() * 2000) + 100,
        marketMakers: Math.floor(Math.random() * 5) + 1,
        details: [`ARCA`, `NSDQ`, `NYSE`][Math.floor(Math.random() * 3)],
        isGenerated: true
      });
    }

    const level2Data = {
      symbol,
      service: 'DEMO_BOOK',
      timestamp: Date.now(),
      bidLevels,
      askLevels
    };

    this.io.emit('level2Update', level2Data);
  }

  /**
   * 生成演示K线数据
   */
  private generateDemoChartData(symbol: string) {
    const stock = this.stockData.get(symbol);
    if (!stock) return;

    const chartData = {
      symbol,
      timestamp: Date.now(),
      open: stock.price + (Math.random() - 0.5) * 0.5,
      high: stock.price + Math.random() * 1,
      low: stock.price - Math.random() * 1,
      close: stock.price,
      volume: Math.floor(Math.random() * 10000) + 1000
    };

    this.io.emit('chartUpdate', chartData);
  }

  /**
   * 处理Level II买卖盘数据
   */
  private handleLevel2Data(service: string, content: any[]) {
    if (!Array.isArray(content)) return;

    content.forEach(item => {
      const symbol = item['0'] || item.key;
      if (!symbol) return;

      // 详细调试Level II数据结构
      console.log(`🔍 [DEBUG] ${service} 原始数据结构:`, JSON.stringify(item, null, 2));

      const level2Info = {
        symbol,
        service,
        timestamp: Date.now(),
        snapshotTime: item['1'],
        bidLevels: this.parseLevel2Levels(item['2']),
        askLevels: this.parseLevel2Levels(item['3']),
        rawData: item // 保留原始数据用于调试
      };

      // 如果没有Level II数据，尝试从Level I数据生成简化版买卖盘
      if (level2Info.bidLevels.length === 0 && level2Info.askLevels.length === 0) {
        const stockData = this.stockData.get(symbol);
        if (stockData && stockData.bid && stockData.ask) {
          level2Info.bidLevels = this.generateMockLevel2FromLevel1(stockData, 'bid');
          level2Info.askLevels = this.generateMockLevel2FromLevel1(stockData, 'ask');
          console.log(`📊 为 ${symbol} 生成基于Level I的买卖盘数据`);
        }
      }

      // 发送Level II数据到客户端
      this.io.emit('level2Update', level2Info);
      
      console.log(`📚 ${service} Level II更新: ${symbol}, 买盘${level2Info.bidLevels.length}层, 卖盘${level2Info.askLevels.length}层`);
    });
  }

  /**
   * 解析Level II价格层级数据
   */
  private parseLevel2Levels(levelsData: any[]): any[] {
    if (!Array.isArray(levelsData)) return [];

    return levelsData.map((level, index) => {
      if (Array.isArray(level) && level.length >= 3) {
        return {
          level: index + 1,
          price: level[0],
          size: level[1],
          marketMakers: level[2] || 0,
          details: level[3] || []
        };
      }
      return null;
    }).filter(level => level !== null);
  }

  /**
   * 处理Chart K线数据
   */
  private handleChartData(content: any[]) {
    if (!Array.isArray(content)) return;

    content.forEach(item => {
      const symbol = item.key || item['0'];
      if (!symbol) return;

      const chartData = {
        symbol,
        timestamp: item['7'] || item['1'] || Date.now(),
        open: item['1'] || item['2'],
        high: item['2'] || item['3'],
        low: item['3'] || item['4'],
        close: item['4'] || item['5'],
        volume: item['5'] || item['6'] || 0,
        sequence: item['6']
      };

      // 发送Chart数据到客户端
      this.io.emit('chartUpdate', chartData);
      
      console.log(`📊 Chart更新: ${symbol} OHLCV: ${chartData.open}/${chartData.high}/${chartData.low}/${chartData.close}/${chartData.volume}`);
    });
  }

  public start() {
    this.server.listen(this.port, () => {
      console.log(`\n🚀 专业股票交易仪表板启动成功!`);
      console.log(`📊 基础版界面: http://localhost:${this.port}`);
      console.log(`🏆 专业版界面: http://localhost:${this.port}/pro`);
      console.log(`🔌 WebSocket端口: ${this.port}`);
      console.log(`📈 功能特性:`);
      console.log(`   ✅ Level 1 实时行情`);
      console.log(`   ✅ Level II 买卖盘深度`);
      console.log(`   ✅ 专业K线图 (支持缩放和刷选)`);
      console.log(`   ✅ Axis Pointer 联动`);
      console.log(`   ✅ 移动端触摸支持`);
      console.log(`   ✅ 技术指标显示`);
      console.log(`   ✅ 多时间周期切换\n`);
    });
  }

  public stop() {
    this.sdk?.disconnectStreamer();
    this.server.close();
  }
}

// 启动服务器
const server = new StockDataServer();
server.start();

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n🛑 正在关闭服务器...');
  server.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 正在关闭服务器...');
  server.stop();
  process.exit(0);
});
