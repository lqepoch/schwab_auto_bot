/**
 * Schwab Streamer 专用调试工具
 * 
 * 提供高级的 Streamer 连接监控、数据分析和问题诊断功能
 * 专门针对 Schwab API 的实时数据流优化
 */

import type { Logger } from './logger.ts';
import { 
  StreamDebugger, 
  ConnectionMonitor, 
  DataVisualizer, 
  PerformanceMonitor,
  parseLevelOneEquities,
  parseNasdaqBook,
  parseChartEquity
} from './debugUtils.ts';

/**
 * Streamer 调试配置选项
 */
export interface StreamerDebugOptions {
  /** 是否启用详细日志 */
  verbose?: boolean;
  /** 是否显示原始数据 */
  showRawData?: boolean;
  /** 是否自动分析数据质量 */
  autoAnalyze?: boolean;
  /** 是否启用可视化图表 */
  enableVisualization?: boolean;
  /** 是否监控性能 */
  enablePerformanceMonitoring?: boolean;
  /** 统计信息打印间隔（毫秒） */
  statisticsInterval?: number;
  /** 是否保存调试日志到文件 */
  saveToFile?: boolean;
  /** 日志文件路径 */
  logFilePath?: string;
}

/**
 * 高级 Streamer 调试器
 * 集成所有调试功能，提供一站式的 Streamer 监控解决方案
 */
export class StreamerDebugger {
  private streamDebugger: StreamDebugger;
  private connectionMonitor: ConnectionMonitor;
  private performanceMonitor: PerformanceMonitor;
  private logger?: Logger;
  private options: Required<StreamerDebugOptions>;
  
  // 数据存储用于可视化
  private priceHistory: Map<string, number[]> = new Map();
  private volumeHistory: Map<string, number[]> = new Map();
  private bookHistory: Map<string, any[]> = new Map();
  
  // 问题检测
  private issues: Array<{
    timestamp: number;
    severity: 'low' | 'medium' | 'high';
    category: 'connection' | 'data' | 'performance';
    message: string;
    details?: any;
  }> = [];

  constructor(options: StreamerDebugOptions = {}, logger?: Logger) {
    this.logger = logger;
    this.options = {
      verbose: false,
      showRawData: false,
      autoAnalyze: true,
      enableVisualization: false,
      enablePerformanceMonitoring: true,
      statisticsInterval: 30000,
      saveToFile: false,
      logFilePath: './streamer-debug.log',
      ...options
    };

    // 初始化子组件
    this.streamDebugger = new StreamDebugger({
      showRawData: this.options.showRawData,
      showStatistics: true,
      showFieldDetails: this.options.verbose,
      showDataQuality: this.options.autoAnalyze,
      statisticsInterval: this.options.statisticsInterval
    });

    this.connectionMonitor = new ConnectionMonitor(logger);
    this.performanceMonitor = new PerformanceMonitor();

    this.logger?.info('StreamerDebugger 已初始化', { options: this.options });
  }

  /**
   * 开始监控 Streamer
   */
  startMonitoring(streamer: any): void {
    this.logger?.info('开始监控 Schwab Streamer');

    // 监听连接事件
    streamer.on('ready', () => {
      this.connectionMonitor.recordEvent('connected', 'Streamer ready');
      this.log('🟢 Streamer 连接就绪');
    });

    streamer.on('close', () => {
      this.connectionMonitor.recordEvent('disconnected', 'Streamer closed');
      this.log('🔴 Streamer 连接关闭');
    });

    streamer.on('reconnecting', () => {
      this.connectionMonitor.recordEvent('reconnecting', 'Auto reconnect triggered');
      this.log('🔄 Streamer 正在重连');
    });

    streamer.on('error', (error: any) => {
      this.connectionMonitor.recordEvent('error', error.message);
      this.log(`❌ Streamer 错误: ${error.message}`);
      this.recordIssue('high', 'connection', `Streamer error: ${error.message}`, error);
    });

    // 监听数据事件
    streamer.on('data', (payload: any) => {
      if (this.options.enablePerformanceMonitoring) {
        this.performanceMonitor.measureTime('data-processing', () => {
          this.processDataPayload(payload);
        });
      } else {
        this.processDataPayload(payload);
      }
    });

    streamer.on('response', (payload: any) => {
      this.processResponsePayload(payload);
    });

    // 启动定期统计
    if (this.options.statisticsInterval > 0) {
      setInterval(() => {
        this.printComprehensiveStats();
      }, this.options.statisticsInterval);
    }
  }

  /**
   * 处理数据负载
   */
  private processDataPayload(payload: any): void {
    const { service, content } = payload;
    
    // 记录到 StreamDebugger
    this.streamDebugger.logData(service, payload);
    
    // 数据质量分析
    if (this.options.autoAnalyze) {
      this.analyzeDataQuality(service, content);
    }
    
    // 存储历史数据用于可视化
    if (this.options.enableVisualization) {
      this.storeHistoricalData(service, content);
    }
    
    // 详细日志
    if (this.options.verbose) {
      this.logDetailedDataInfo(service, content);
    }
  }

  /**
   * 处理响应负载
   */
  private processResponsePayload(payload: any): void {
    const { service, content } = payload;
    const isSuccess = content?.code === 0;
    
    if (isSuccess) {
      this.log(`✅ [RESPONSE] ${service}: ${content?.msg || 'Success'}`);
    } else {
      this.log(`❌ [RESPONSE] ${service}: ${content?.msg || 'Failed'}`);
      this.recordIssue('medium', 'data', `Subscription failed: ${service}`, payload);
    }
    
    if (this.options.verbose) {
      this.log(`🔍 [RESPONSE DETAILS] ${JSON.stringify(payload, null, 2)}`);
    }
  }

  /**
   * 分析数据质量
   */
  private analyzeDataQuality(service: string, content: any[]): void {
    if (!Array.isArray(content)) return;
    
    let emptyItems = 0;
    let incompleteItems = 0;
    
    content.forEach(item => {
      if (!item || Object.keys(item).length === 0) {
        emptyItems++;
      } else {
        // 检查关键字段
        const hasBasicFields = this.checkBasicFields(service, item);
        if (!hasBasicFields) {
          incompleteItems++;
        }
      }
    });
    
    const totalItems = content.length;
    const qualityScore = (totalItems - emptyItems - incompleteItems) / totalItems;
    
    if (qualityScore < 0.7) {
      this.recordIssue('medium', 'data', 
        `Data quality issue in ${service}: ${Math.round(qualityScore * 100)}% quality`,
        { emptyItems, incompleteItems, totalItems, qualityScore }
      );
    }
  }

  /**
   * 检查基础字段
   */
  private checkBasicFields(service: string, item: any): boolean {
    switch (service) {
      case 'LEVELONE_EQUITIES':
        return item['1'] !== undefined || item['2'] !== undefined || item['3'] !== undefined;
      case 'NASDAQ_BOOK':
      case 'NYSE_BOOK':
        return item['0'] !== undefined && (item['2'] !== undefined || item['3'] !== undefined);
      case 'CHART_EQUITY':
        return item['1'] !== undefined && item['2'] !== undefined;
      default:
        return true;
    }
  }

  /**
   * 存储历史数据
   */
  private storeHistoricalData(service: string, content: any[]): void {
    if (!Array.isArray(content)) return;
    
    content.forEach(item => {
      const symbol = item.key || item['0'];
      if (!symbol) return;
      
      switch (service) {
        case 'LEVELONE_EQUITIES':
          const price = item['3']; // 最新价
          const volume = item['8']; // 成交量
          
          if (price !== undefined) {
            if (!this.priceHistory.has(symbol)) {
              this.priceHistory.set(symbol, []);
            }
            const prices = this.priceHistory.get(symbol)!;
            prices.push(price);
            if (prices.length > 100) prices.shift(); // 保持最近100个数据点
          }
          
          if (volume !== undefined) {
            if (!this.volumeHistory.has(symbol)) {
              this.volumeHistory.set(symbol, []);
            }
            const volumes = this.volumeHistory.get(symbol)!;
            volumes.push(volume);
            if (volumes.length > 100) volumes.shift();
          }
          break;
          
        case 'NASDAQ_BOOK':
        case 'NYSE_BOOK':
          if (!this.bookHistory.has(symbol)) {
            this.bookHistory.set(symbol, []);
          }
          const books = this.bookHistory.get(symbol)!;
          books.push({
            timestamp: Date.now(),
            bidLevels: item['2'],
            askLevels: item['3']
          });
          if (books.length > 20) books.shift(); // 保持最近20个快照
          break;
      }
    });
  }

  /**
   * 记录详细数据信息
   */
  private logDetailedDataInfo(service: string, content: any[]): void {
    if (!Array.isArray(content)) return;
    
    content.forEach((item, index) => {
      this.log(`🔍 [${service}] Item #${index + 1}:`);
      
      switch (service) {
        case 'LEVELONE_EQUITIES':
          this.log(parseLevelOneEquities(item));
          break;
        case 'NASDAQ_BOOK':
        case 'NYSE_BOOK':
          this.log(parseNasdaqBook(item));
          break;
        case 'CHART_EQUITY':
          this.log(parseChartEquity(item));
          break;
        default:
          this.log(`   Raw data: ${JSON.stringify(item, null, 2)}`);
      }
    });
  }

  /**
   * 记录问题
   */
  private recordIssue(severity: 'low' | 'medium' | 'high', category: 'connection' | 'data' | 'performance', message: string, details?: any): void {
    const issue = {
      timestamp: Date.now(),
      severity,
      category,
      message,
      details
    };
    
    this.issues.push(issue);
    
    // 保留最近100个问题
    if (this.issues.length > 100) {
      this.issues.shift();
    }
    
    // 根据严重程度选择日志级别
    switch (severity) {
      case 'high':
        this.logger?.error(`[ISSUE] ${message}`, details);
        break;
      case 'medium':
        this.logger?.warn(`[ISSUE] ${message}`, details);
        break;
      case 'low':
        this.logger?.debug(`[ISSUE] ${message}`, details);
        break;
    }
  }

  /**
   * 打印综合统计信息
   */
  printComprehensiveStats(): void {
    console.log('\n' + '='.repeat(80));
    console.log('📊 Schwab Streamer 综合监控报告');
    console.log('='.repeat(80));
    
    // 连接统计
    this.connectionMonitor.printConnectionStats();
    
    // 数据统计
    this.streamDebugger.printStatistics();
    
    // 性能统计
    if (this.options.enablePerformanceMonitoring) {
      this.performanceMonitor.printPerformanceStats();
    }
    
    // 问题统计
    this.printIssuesSummary();
    
    // 可视化图表
    if (this.options.enableVisualization) {
      this.printVisualizationCharts();
    }
    
    console.log('='.repeat(80));
  }

  /**
   * 打印问题摘要
   */
  private printIssuesSummary(): void {
    const recentIssues = this.issues.filter(issue => 
      Date.now() - issue.timestamp < this.options.statisticsInterval
    );
    
    if (recentIssues.length === 0) {
      console.log('\n✅ 问题统计: 无问题发现');
      return;
    }
    
    console.log('\n⚠️ 问题统计:');
    console.log('─'.repeat(50));
    
    const issuesByCategory = recentIssues.reduce((acc: any, issue) => {
      acc[issue.category] = (acc[issue.category] || 0) + 1;
      return acc;
    }, {});
    
    const issuesBySeverity = recentIssues.reduce((acc: any, issue) => {
      acc[issue.severity] = (acc[issue.severity] || 0) + 1;
      return acc;
    }, {});
    
    console.log(`📊 总问题数: ${recentIssues.length}`);
    console.log(`📋 按类别: ${Object.entries(issuesByCategory).map(([k, v]) => `${k}:${v}`).join(', ')}`);
    console.log(`🚨 按严重程度: ${Object.entries(issuesBySeverity).map(([k, v]) => `${k}:${v}`).join(', ')}`);
    
    // 显示最近的高严重度问题
    const highSeverityIssues = recentIssues.filter(issue => issue.severity === 'high');
    if (highSeverityIssues.length > 0) {
      console.log('\n🚨 高严重度问题:');
      highSeverityIssues.slice(-3).forEach(issue => {
        const timeStr = new Date(issue.timestamp).toLocaleString();
        console.log(`   ${timeStr}: ${issue.message}`);
      });
    }
  }

  /**
   * 打印可视化图表
   */
  private printVisualizationCharts(): void {
    console.log('\n📈 数据可视化:');
    console.log('─'.repeat(50));
    
    // 价格图表
    for (const [symbol, prices] of this.priceHistory.entries()) {
      if (prices.length >= 5) {
        console.log(`\n📊 ${symbol} 价格走势:`);
        console.log(DataVisualizer.createPriceChart(prices.slice(-30), 50, 8));
      }
    }
    
    // 成交量图表
    for (const [symbol, volumes] of this.volumeHistory.entries()) {
      if (volumes.length >= 5) {
        console.log(`\n📊 ${symbol} 成交量:`);
        console.log(DataVisualizer.createVolumeChart(volumes.slice(-30), 50, 5));
      }
    }
    
    // Level II 买卖盘
    for (const [symbol, books] of this.bookHistory.entries()) {
      if (books.length > 0) {
        const latestBook = books[books.length - 1];
        if (latestBook.bidLevels || latestBook.askLevels) {
          console.log(`\n📚 ${symbol} Level II 买卖盘:`);
          console.log(DataVisualizer.createBookVisualization(
            latestBook.bidLevels || [],
            latestBook.askLevels || [],
            5
          ));
        }
      }
    }
  }

  /**
   * 获取诊断报告
   */
  getDiagnosticReport(): any {
    return {
      timestamp: Date.now(),
      connection: this.connectionMonitor.getConnectionStats(),
      streaming: this.streamDebugger.getStatsSummary(),
      performance: this.options.enablePerformanceMonitoring 
        ? this.performanceMonitor.getPerformanceStats() 
        : null,
      issues: {
        total: this.issues.length,
        recent: this.issues.filter(issue => Date.now() - issue.timestamp < 300000), // 最近5分钟
        bySeverity: this.issues.reduce((acc: any, issue) => {
          acc[issue.severity] = (acc[issue.severity] || 0) + 1;
          return acc;
        }, {}),
        byCategory: this.issues.reduce((acc: any, issue) => {
          acc[issue.category] = (acc[issue.category] || 0) + 1;
          return acc;
        }, {})
      },
      dataHistory: {
        priceSymbols: Array.from(this.priceHistory.keys()),
        volumeSymbols: Array.from(this.volumeHistory.keys()),
        bookSymbols: Array.from(this.bookHistory.keys())
      }
    };
  }

  /**
   * 重置所有统计
   */
  resetAllStats(): void {
    this.streamDebugger.resetStats();
    this.performanceMonitor.resetStats();
    this.issues.length = 0;
    this.priceHistory.clear();
    this.volumeHistory.clear();
    this.bookHistory.clear();
    
    this.log('📊 所有统计数据已重置');
  }

  /**
   * 内部日志方法
   */
  private log(message: string): void {
    console.log(message);
    
    if (this.options.saveToFile) {
      // TODO: 实现文件日志功能
    }
  }
}

/**
 * 快速创建 StreamerDebugger 实例的工厂函数
 */
export function createStreamerDebugger(options: StreamerDebugOptions = {}, logger?: Logger): StreamerDebugger {
  return new StreamerDebugger(options, logger);
}

/**
 * 用于 examples 的简化调试器
 */
export function createQuickDebugger(verbose: boolean = false): StreamerDebugger {
  return new StreamerDebugger({
    verbose,
    showRawData: verbose,
    autoAnalyze: true,
    enableVisualization: verbose,
    enablePerformanceMonitoring: true,
    statisticsInterval: 30000
  });
}
