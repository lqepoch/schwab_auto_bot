================================================
FILE: src/access.ts
================================================
/**
 * @function fetchToken
 * @author Jason Levitt
 * @description Dedicated routine for refreshing the Schwab access token
 * @param {Credentials} creds - Access credentials necessary to generate a token
 * @returns {Promise<TokenResponse>} A promise that resolves to a JSON object containing the token data
 */

import logger from "./logger.js";

interface Credentials {
  appKey: string;
  appSecret: string;
  appRefresh: string;
  access_token: string; // Current access token, refreshed as needed
  access_exp: number; // Expiration timestamp in seconds. Expires every 29 minutes.
}

async function fetchToken(
  creds: Credentials,
): Promise<Record<string, unknown>> {
  const basicAuth = Buffer.from(`${creds.appKey}:${creds.appSecret}`).toString(
    "base64",
  );

  logger("fetch", "args", "credentials args only for fetchToken(): ", creds);

  try {
    const response = await fetch("https://api.schwabapi.com/v1/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basicAuth}`,
        "Accept-Encoding": "gzip",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: creds.appRefresh,
      }),
    });

    logger("fetch", "raw-response", "raw fetchToken() response", response);

    if (!response.ok) {
      throw new Error(`Error: ${response.status} - ${response.statusText}`);
    }

    const data: Record<string, unknown> = await response.json();
    return data;
  } catch (error) {
    console.error("Fetch error in Refresh:", (error as Error).message);
    throw error;
  }
}

export default fetchToken;



================================================
FILE: src/endpoints.ts
================================================
/**
 * @author Jason Levitt
 * @description All the Schwab REST API endpoints
 */
type Endpoint = {
  ACCTDETAILS: (accthash: string) => string;
  ACCTLIST: string;
  ACCTNUMS: string;
  CHAINS: string;
  CHAINSEXP: string;
  INST: string;
  INSTID: (cusip: string) => string;
  MARKETS: string;
  MARKETSID: (mktid: string) => string;
  MOVERS: (ticker: string) => string;
  ORDALL: string;
  ORDID: (accountHash: string, orderid: string) => string;
  ORDPREV: (accthash: string) => string;
  ORDS: (accthash: string) => string;
  PREFS: string;
  PRICEHIST: string;
  QUOTEID: (ticker: string) => string;
  QUOTES: string;
  TRANS: (accthash: string) => string;
  TRANSID: (accthash: string, transid: string) => string;
};

const endpoint: Endpoint = {
  ACCTDETAILS: (accthash) =>
    `https://api.schwabapi.com/trader/v1/accounts/${accthash}`,
  ACCTLIST: "https://api.schwabapi.com/trader/v1/accounts/",
  ACCTNUMS: "https://api.schwabapi.com/trader/v1/accounts/accountNumbers",
  CHAINS: "https://api.schwabapi.com/marketdata/v1/chains",
  CHAINSEXP: "https://api.schwabapi.com/marketdata/v1/expirationchain",
  INST: "https://api.schwabapi.com/marketdata/v1/instruments",
  INSTID: (cusip) =>
    `https://api.schwabapi.com/marketdata/v1/instruments/${cusip}`,
  MARKETS: "https://api.schwabapi.com/marketdata/v1/markets",
  MARKETSID: (mktid) =>
    `https://api.schwabapi.com/marketdata/v1/markets/${mktid}`,
  MOVERS: (ticker) =>
    `https://api.schwabapi.com/marketdata/v1/movers/${ticker}`,
  ORDALL: "https://api.schwabapi.com/trader/v1/orders",
  ORDID: (accountHash, orderid) =>
    `https://api.schwabapi.com/trader/v1/accounts/${accountHash}/orders/${orderid}`,
  ORDPREV: (accthash) =>
    `https://api.schwabapi.com/trader/v1/accounts/${accthash}/previewOrder`,
  ORDS: (accthash) =>
    `https://api.schwabapi.com/trader/v1/accounts/${accthash}/orders`,
  PREFS: "https://api.schwabapi.com/trader/v1/userPreference",
  PRICEHIST: "https://api.schwabapi.com/marketdata/v1/pricehistory",
  QUOTEID: (ticker) =>
    `https://api.schwabapi.com/marketdata/v1/${ticker}/quotes`,
  QUOTES: "https://api.schwabapi.com/marketdata/v1/quotes",
  TRANS: (accthash) =>
    `https://api.schwabapi.com/trader/v1/accounts/${accthash}/transactions`,
  TRANSID: (accthash, transid) =>
    `https://api.schwabapi.com/trader/v1/accounts/${accthash}/transactions/${transid}`,
};

export default endpoint;



================================================
FILE: src/fetch.ts
================================================
/**
 * @function fetchData
 * @author Jason Levitt
 * @description General purpose fetch routine for making REST API calls.
 * It uses the built-in NodeJS fetch() (node version 18 and newer).
 * @param {string} url - The full URL including any parameters
 * @param {Object} args - Optional configuration structure
 * @param {string} [args.type] -  The REST verb e.g. "GET"
 * @param {Object} [args.headers] - A set of HTTP header key/value pairs
 * @param {Object} [args.body] - A set of key/value paris
 * @returns {Promise<Object>} A promise that resolves to a JSON object
 */

import logger from "./logger.js";

function isErrorResponse(obj: any): obj is { errors: { detail: string }[] } {
  return (
    obj &&
    typeof obj === "object" &&
    Array.isArray(obj.errors) &&
    typeof obj.errors[0]?.detail === "string"
  );
}

function isMessageResponse(obj: any): obj is { message: string } {
  return obj && typeof obj === "object" && typeof obj.message === "string";
}

interface RequestArgs {
  type?: string; // e.g., "GET", "POST"
  headers?: Record<string, string>; // HTTP headers as key-value pairs
  body?: Record<string, unknown> | string; // Request body as an object or already stringified
}

async function fetchData(
  url: string,
  args: RequestArgs = {},
): Promise<Record<string, unknown> | null> {
  // Just for logging, let's combine url into args
  const combinedArgs = { ...args, url };
  logger("fetch", "args", "fetch call args: ", combinedArgs);

  try {
    // Construct the fetch options
    const fetchOptions: RequestInit = {
      method: args.type || "GET",
      headers: { ...args.headers },
      ...(args.body
        ? {
            body:
              typeof args.body === "string"
                ? args.body
                : JSON.stringify(args.body),
          }
        : {}),
    };

    // Perform the fetch call
    const response = await fetch(url, fetchOptions);

    logger("fetch", "raw-response", "raw fetch response", response);

    // Handle non-OK responses
    if (!response.ok) {
      // Get the text version of the response because we can't depend on JSON here
      let rt: object | string = await response.text();
      // Check for garbage nothingness that Schwab returns sometimes
      const cleanedString = rt.toString().replace(/\s+/g, "");
      if (rt && cleanedString.length !== 0) {
        // We hope it's a real JSON object now
        rt = JSON.parse(rt);
        if (isErrorResponse(rt)) {
          if (rt.errors[0]?.detail) {
            // The "detail" has details about the error
            rt = rt.errors[0].detail;
          }
        } else if (isMessageResponse(rt)) {
          // The "message" has details about the error
          rt = rt.message;
        } else {
          rt = "No details were returned";
        }
      } else {
        rt = "no details were returned";
      }
      throw new Error(
        `Error: ${response.status} - ${response.statusText} - Details: ${rt}`,
      );
    } else {
      // Handle the case where nothing is returned but the call is successful (e.g. trades)
      // Why does Schwab put the orderId in the location header?
      // In the case of deleteOrder(), return null.
      const responseText = await response.text();
      if (responseText) {
        const data: Record<string, unknown> = JSON.parse(responseText);
        return data;
      } else {
        const orderId =
          response.headers.get("location")?.split("/").pop() || null;
        if (orderId) {
          const jsonResponse = { orderId: orderId };
          return jsonResponse;
        } else {
          // Empty response body happens on orderDelete call
          return null;
        }
      }
    }
  } catch (error) {
    console.error("Fetch error:", (error as Error).message);
    throw error;
  }
}

export default fetchData;



================================================
FILE: src/initenv.ts
================================================
/**
 * @function initenv
 * @author Jason Levitt
 * @description Loads the .env file once
 */
import dotenv from "dotenv";
import debug from "debug";

dotenv.config();

if (process.env.DEBUG) {
  debug.enable(process.env.DEBUG);
}



================================================
FILE: src/logger.ts
================================================
// DEFINED LOGGERS
//
// Display all streaming messages and events
// DEBUG=streaming:msgs
// logger("streaming", "msgs", "[description of event]", [technical details]);
//
// Display arguments to all fetch calls
// DEBUG=fetch:args
// logger("fetch", "args", "[description of event]", [technical details]);
//
// Display raw response object (data is not displayed) all fetch calls
// DEBUG=fetch:raw-response
// logger("fetch", "raw-response", "[description of event]", [technical details]);
//

import "./initenv.js";
import debug from "debug";

export default function logger(
  namespace: string,
  level: string,
  message: string,
  context?: unknown,
): void {
  const log = debug(`${namespace}:${level}`); // Use the correct namespace

  if (log.enabled) {
    if (context !== undefined) {
      if (typeof context === "object" && context !== null) {
        log(`${message}`, context); // Log structured data
      } else {
        log(`${message}`, { context }); // Wrap primitives in an object
      }
    } else {
      log(message); // Log message without context
    }
  }
}



================================================
FILE: src/orderhelp.ts
================================================
/**
 * @file orderhelp.ts
 * @author Jason Levitt
 * @license MIT
 *
 * @description Provides helper methods to create JSON order objects for input
 * into Schwab API trading functions. All 27 functions are listed in the export
 * statement immediately below these comments. All of the functions except for
 * optionSymbol() create output a JSON object suitable for creating a trade of
 * some kind. optionSymbol() just generates option symbols in the format used
 * by Schwab.
 *
 * These functions are based on the Python helper functions created by Alex Golec which
 * are documented here:  https://schwab-py.readthedocs.io/en/latest/order-templates.html
 *
 * @example
 * import { equityBuyToCoverLimit } from "schwab-client-js/orderhelp";
 * const trade = equityBuyToCoverLimit("AMD", 3, "55.33");
 *
 */

export {
  optionSymbol,
  equityBuyLimit,
  equityBuyMarket,
  equitySellMarket,
  equitySellLimit,
  equitySellShortMarket,
  equitySellShortLimit,
  equityBuyToCoverMarket,
  equityBuyToCoverLimit,
  optionBuyToOpenMarket,
  optionBuyToOpenLimit,
  optionSellToOpenMarket,
  optionSellToOpenLimit,
  optionBuyToCloseMarket,
  optionBuyToCloseLimit,
  optionSellToCloseMarket,
  optionSellToCloseLimit,
  bullCallVerticalOpen,
  bullCallVerticalClose,
  bullPutVerticalOpen,
  bullPutVerticalClose,
  bearCallVerticalOpen,
  bearCallVerticalClose,
  bearPutVerticalClose,
  bearPutVerticalOpen,
  oneCancelsOther,
  firstTriggersSecond,
};

// Define reusable types and interfaces
type OrderType =
  | "MARKET"
  | "LIMIT"
  | "STOP"
  | "STOP_LIMIT"
  | "TRAILING_STOP"
  | "CABINET"
  | "NON_MARKETABLE"
  | "MARKET_ON_CLOSE"
  | "EXERCISE"
  | "TRAILING_STOP_LIMIT"
  | "NET_DEBIT"
  | "NET_CREDIT"
  | "NET_ZERO"
  | "LIMIT_ON_CLOSE";
type SessionType = "NORMAL" | "AM" | "PM" | "SEAMLESS";
type DurationType =
  | "DAY"
  | "GOOD_TILL_CANCEL"
  | "FILL_OR_KILL"
  | "IMMEDIATE_OR_CANCEL"
  | "END_OF_WEEK"
  | "END_OF_MONTH"
  | "NEXT_END_OF_MONTH"
  | "UNKNOWN";
type OrderStrategyType =
  | "SINGLE"
  | "CANCEL"
  | "RECALL"
  | "PAIR"
  | "FLATTEN"
  | "TWO_DAY_SWAP"
  | "BLAST_ALL"
  | "OCO"
  | "TRIGGER";
type ComplexOrderStrategyType =
  | "NONE"
  | "COVERED"
  | "VERTICAL"
  | "BACK_RATIO"
  | "CALENDAR"
  | "DIAGONAL"
  | "STRADDLE"
  | "STRANGLE"
  | "COLLAR_SYNTHETIC"
  | "BUTTERFLY"
  | "CONDOR"
  | "IRON_CONDOR"
  | "VERTICAL_ROLL"
  | "COLLAR_WITH_STOCK"
  | "DOUBLE_DIAGONAL"
  | "UNBALANCED_BUTTERFLY"
  | "UNBALANCED_CONDOR"
  | "UNBALANCED_IRON_CONDOR"
  | "UNBALANCED_VERTICAL_ROLL"
  | "MUTUAL_FUND_SWAP"
  | "CUSTOM";
type InstructionType =
  | "BUY"
  | "SELL"
  | "BUY_TO_COVER"
  | "SELL_SHORT"
  | "BUY_TO_OPEN"
  | "BUY_TO_CLOSE"
  | "SELL_TO_OPEN"
  | "SELL_TO_CLOSE"
  | "EXCHANGE"
  | "SELL_SHORT_EXEMPT";
type AssetType = "EQUITY" | "OPTION";

interface Instrument {
  symbol: string;
  assetType: AssetType;
}

interface OrderLeg {
  instruction: InstructionType;
  quantity: number;
  instrument: Instrument;
}

interface Order {
  orderType: OrderType;
  session: SessionType;
  duration: DurationType;
  orderStrategyType: OrderStrategyType;
  complexOrderStrategyType?: ComplexOrderStrategyType;
  quantity?: number;
  price?: string;
  orderLegCollection: OrderLeg[];
  childOrderStrategies?: Order[];
}

interface CompositeOrder {
  orderStrategyType: "OCO" | "TRIGGER";
  childOrderStrategies: Order[];
}

// Function implementations

function optionSymbol(
  symbol: string,
  expirationDate: string,
  contractType: "C" | "P",
  strikePrice: string,
): string {
  if (!/^\d{6}$/.test(expirationDate)) {
    throw new Error("Expiration date must be in 'YYMMDD' format.");
  }

  const year = parseInt(expirationDate.slice(0, 2), 10);
  const month = parseInt(expirationDate.slice(2, 4), 10);
  const day = parseInt(expirationDate.slice(4, 6), 10);

  if (year < 0 || year > 99) {
    throw new Error("Year must be a two-digit number between 00 and 99.");
  }
  if (month < 1 || month > 12) {
    throw new Error("Month must be a number between 01 and 12.");
  }
  if (day < 1 || day > 31) {
    throw new Error("Day must be a number between 01 and 31.");
  }

  const upperType = contractType.toUpperCase();
  if (upperType !== "C" && upperType !== "P") {
    throw new Error("Contract type must be 'C' or 'P'");
  }

  const parsedPrice = parseFloat(strikePrice);
  if (isNaN(parsedPrice) || parsedPrice <= 0) {
    throw new Error("Strike price must be a positive number.");
  }
  const formattedStrikePrice = (parsedPrice * 1000).toString().padStart(8, "0");
  const paddedSymbol = symbol.padEnd(6, " ");

  return `${paddedSymbol}${expirationDate}${contractType}${formattedStrikePrice}`;
}

function equityBuyLimit(
  symbol: string,
  quantity: number,
  price: string,
): Order {
  return {
    orderType: "LIMIT",
    session: "NORMAL",
    duration: "DAY",
    orderStrategyType: "SINGLE",
    orderLegCollection: [
      {
        instruction: "BUY",
        quantity,
        instrument: { symbol, assetType: "EQUITY" },
      },
    ],
    price,
  };
}

function equityBuyMarket(symbol: string, quantity: number): Order {
  return {
    orderType: "MARKET",
    session: "NORMAL",
    duration: "DAY",
    orderStrategyType: "SINGLE",
    orderLegCollection: [
      {
        instruction: "BUY",
        quantity,
        instrument: { symbol, assetType: "EQUITY" },
      },
    ],
  };
}

function equitySellMarket(symbol: string, quantity: number): Order {
  return {
    orderType: "MARKET",
    session: "NORMAL",
    duration: "DAY",
    orderStrategyType: "SINGLE",
    orderLegCollection: [
      {
        instruction: "SELL",
        quantity,
        instrument: { symbol, assetType: "EQUITY" },
      },
    ],
  };
}

function equitySellLimit(
  symbol: string,
  quantity: number,
  price: string,
): Order {
  return {
    orderType: "LIMIT",
    session: "NORMAL",
    duration: "DAY",
    orderStrategyType: "SINGLE",
    orderLegCollection: [
      {
        instruction: "SELL",
        quantity,
        instrument: { symbol, assetType: "EQUITY" },
      },
    ],
    price,
  };
}

function equitySellShortMarket(symbol: string, quantity: number): Order {
  return {
    orderType: "MARKET",
    session: "NORMAL",
    duration: "DAY",
    orderStrategyType: "SINGLE",
    orderLegCollection: [
      {
        instruction: "SELL_SHORT",
        quantity,
        instrument: { symbol, assetType: "EQUITY" },
      },
    ],
  };
}

function equitySellShortLimit(
  symbol: string,
  quantity: number,
  price: string,
): Order {
  return {
    orderType: "LIMIT",
    session: "NORMAL",
    duration: "DAY",
    orderStrategyType: "SINGLE",
    orderLegCollection: [
      {
        instruction: "SELL_SHORT",
        quantity,
        instrument: { symbol, assetType: "EQUITY" },
      },
    ],
    price,
  };
}

function equityBuyToCoverMarket(symbol: string, quantity: number): Order {
  return {
    orderType: "MARKET",
    session: "NORMAL",
    duration: "DAY",
    orderStrategyType: "SINGLE",
    orderLegCollection: [
      {
        instruction: "BUY_TO_COVER",
        quantity,
        instrument: { symbol, assetType: "EQUITY" },
      },
    ],
  };
}

function equityBuyToCoverLimit(
  symbol: string,
  quantity: number,
  price: string,
): Order {
  return {
    orderType: "LIMIT",
    session: "NORMAL",
    duration: "DAY",
    orderStrategyType: "SINGLE",
    orderLegCollection: [
      {
        instruction: "BUY_TO_COVER",
        quantity,
        instrument: { symbol, assetType: "EQUITY" },
      },
    ],
    price,
  };
}

function optionBuyToOpenMarket(symbol: string, quantity: number): Order {
  return {
    orderType: "MARKET",
    session: "NORMAL",
    duration: "DAY",
    orderStrategyType: "SINGLE",
    orderLegCollection: [
      {
        instruction: "BUY_TO_OPEN",
        quantity,
        instrument: { symbol, assetType: "OPTION" },
      },
    ],
  };
}

function optionBuyToOpenLimit(
  symbol: string,
  quantity: number,
  price: string,
): Order {
  return {
    orderType: "LIMIT",
    session: "NORMAL",
    duration: "DAY",
    orderStrategyType: "SINGLE",
    orderLegCollection: [
      {
        instruction: "BUY_TO_OPEN",
        quantity,
        instrument: { symbol, assetType: "OPTION" },
      },
    ],
    price,
  };
}

function optionSellToOpenMarket(symbol: string, quantity: number): Order {
  return {
    orderType: "MARKET",
    session: "NORMAL",
    duration: "DAY",
    orderStrategyType: "SINGLE",
    orderLegCollection: [
      {
        instruction: "SELL_TO_OPEN",
        quantity,
        instrument: { symbol, assetType: "OPTION" },
      },
    ],
  };
}

function optionSellToOpenLimit(
  symbol: string,
  quantity: number,
  price: string,
): Order {
  return {
    orderType: "LIMIT",
    session: "NORMAL",
    duration: "DAY",
    orderStrategyType: "SINGLE",
    orderLegCollection: [
      {
        instruction: "SELL_TO_OPEN",
        quantity,
        instrument: { symbol, assetType: "OPTION" },
      },
    ],
    price,
  };
}

function optionBuyToCloseMarket(symbol: string, quantity: number): Order {
  return {
    orderType: "MARKET",
    session: "NORMAL",
    duration: "DAY",
    orderStrategyType: "SINGLE",
    orderLegCollection: [
      {
        instruction: "BUY_TO_CLOSE",
        quantity,
        instrument: { symbol, assetType: "OPTION" },
      },
    ],
  };
}

function optionBuyToCloseLimit(
  symbol: string,
  quantity: number,
  price: string,
): Order {
  return {
    orderType: "LIMIT",
    session: "NORMAL",
    duration: "DAY",
    orderStrategyType: "SINGLE",
    orderLegCollection: [
      {
        instruction: "BUY_TO_CLOSE",
        quantity,
        instrument: { symbol, assetType: "OPTION" },
      },
    ],
    price,
  };
}

function optionSellToCloseMarket(symbol: string, quantity: number): Order {
  return {
    orderType: "MARKET",
    session: "NORMAL",
    duration: "DAY",
    orderStrategyType: "SINGLE",
    orderLegCollection: [
      {
        instruction: "SELL_TO_CLOSE",
        quantity,
        instrument: { symbol, assetType: "OPTION" },
      },
    ],
  };
}

function optionSellToCloseLimit(
  symbol: string,
  quantity: number,
  price: string,
): Order {
  return {
    orderType: "LIMIT",
    session: "NORMAL",
    duration: "DAY",
    orderStrategyType: "SINGLE",
    orderLegCollection: [
      {
        instruction: "SELL_TO_CLOSE",
        quantity,
        instrument: { symbol, assetType: "OPTION" },
      },
    ],
    price,
  };
}

function bullCallVerticalOpen(
  long_symbol: string,
  short_symbol: string,
  quantity: number,
  price: string,
): Order {
  return {
    session: "NORMAL",
    duration: "DAY",
    orderType: "NET_DEBIT",
    complexOrderStrategyType: "VERTICAL",
    quantity,
    price: price.toString(),
    orderLegCollection: [
      {
        instruction: "BUY_TO_OPEN",
        quantity,
        instrument: { symbol: long_symbol, assetType: "OPTION" },
      },
      {
        instruction: "SELL_TO_OPEN",
        quantity,
        instrument: { symbol: short_symbol, assetType: "OPTION" },
      },
    ],
    orderStrategyType: "SINGLE",
  };
}

function bullCallVerticalClose(
  short_symbol: string,
  long_symbol: string,
  quantity: number,
  price: string,
): Order {
  return {
    session: "NORMAL",
    duration: "DAY",
    orderType: "NET_DEBIT",
    complexOrderStrategyType: "VERTICAL",
    quantity,
    price: price.toString(),
    orderLegCollection: [
      {
        instruction: "SELL_TO_CLOSE",
        quantity,
        instrument: { symbol: short_symbol, assetType: "OPTION" },
      },
      {
        instruction: "BUY_TO_CLOSE",
        quantity,
        instrument: { symbol: long_symbol, assetType: "OPTION" },
      },
    ],
    orderStrategyType: "SINGLE",
  };
}

function bullPutVerticalOpen(
  long_put_symbol: string,
  short_put_symbol: string,
  quantity: number,
  price: string,
): Order {
  return {
    session: "NORMAL",
    duration: "DAY",
    orderType: "NET_CREDIT",
    complexOrderStrategyType: "VERTICAL",
    quantity,
    price: price.toString(),
    orderLegCollection: [
      {
        instruction: "BUY_TO_OPEN",
        quantity,
        instrument: { symbol: long_put_symbol, assetType: "OPTION" },
      },
      {
        instruction: "SELL_TO_OPEN",
        quantity,
        instrument: { symbol: short_put_symbol, assetType: "OPTION" },
      },
    ],
    orderStrategyType: "SINGLE",
  };
}

function bullPutVerticalClose(
  long_put_symbol: string,
  short_put_symbol: string,
  quantity: number,
  price: string,
): Order {
  return {
    session: "NORMAL",
    duration: "DAY",
    orderType: "NET_DEBIT",
    complexOrderStrategyType: "VERTICAL",
    quantity,
    price: price.toString(),
    orderLegCollection: [
      {
        instruction: "SELL_TO_CLOSE",
        quantity,
        instrument: { symbol: long_put_symbol, assetType: "OPTION" },
      },
      {
        instruction: "BUY_TO_CLOSE",
        quantity,
        instrument: { symbol: short_put_symbol, assetType: "OPTION" },
      },
    ],
    orderStrategyType: "SINGLE",
  };
}

function bearCallVerticalOpen(
  short_symbol: string,
  long_symbol: string,
  quantity: number,
  price: string,
): Order {
  return {
    session: "NORMAL",
    duration: "DAY",
    orderType: "NET_CREDIT",
    complexOrderStrategyType: "VERTICAL",
    quantity,
    price: price.toString(),
    orderLegCollection: [
      {
        instruction: "SELL_TO_OPEN",
        quantity,
        instrument: { symbol: short_symbol, assetType: "OPTION" },
      },
      {
        instruction: "BUY_TO_OPEN",
        quantity,
        instrument: { symbol: long_symbol, assetType: "OPTION" },
      },
    ],
    orderStrategyType: "SINGLE",
  };
}

function bearCallVerticalClose(
  symbol1: string,
  symbol2: string,
  quantity: number,
  price: string,
): Order {
  return {
    session: "NORMAL",
    duration: "DAY",
    orderType: "NET_DEBIT",
    complexOrderStrategyType: "VERTICAL",
    quantity,
    price: price.toString(),
    orderLegCollection: [
      {
        instruction: "BUY_TO_CLOSE",
        quantity,
        instrument: { symbol: symbol1, assetType: "OPTION" },
      },
      {
        instruction: "SELL_TO_CLOSE",
        quantity,
        instrument: { symbol: symbol2, assetType: "OPTION" },
      },
    ],
    orderStrategyType: "SINGLE",
  };
}

function bearPutVerticalClose(
  short_put_symbol: string,
  long_put_symbol: string,
  quantity: number,
  price: string,
): Order {
  return {
    session: "NORMAL",
    duration: "DAY",
    orderType: "NET_CREDIT",
    complexOrderStrategyType: "VERTICAL",
    quantity,
    price: price.toString(),
    orderLegCollection: [
      {
        instruction: "BUY_TO_CLOSE",
        quantity,
        instrument: { symbol: short_put_symbol, assetType: "OPTION" },
      },
      {
        instruction: "SELL_TO_CLOSE",
        quantity,
        instrument: { symbol: long_put_symbol, assetType: "OPTION" },
      },
    ],
    orderStrategyType: "SINGLE",
  };
}

function bearPutVerticalOpen(
  short_put_symbol: string,
  long_put_symbol: string,
  quantity: number,
  price: string,
): Order {
  return {
    session: "NORMAL",
    duration: "DAY",
    orderType: "NET_DEBIT",
    complexOrderStrategyType: "VERTICAL",
    quantity,
    price: price.toString(),
    orderLegCollection: [
      {
        instruction: "SELL_TO_OPEN",
        quantity,
        instrument: { symbol: short_put_symbol, assetType: "OPTION" },
      },
      {
        instruction: "BUY_TO_OPEN",
        quantity,
        instrument: { symbol: long_put_symbol, assetType: "OPTION" },
      },
    ],
    orderStrategyType: "SINGLE",
  };
}

function oneCancelsOther(
  primaryOrder: Order,
  secondaryOrder: Order,
): CompositeOrder {
  return {
    orderStrategyType: "OCO",
    childOrderStrategies: [
      {
        ...primaryOrder,
        orderStrategyType: "TRIGGER",
        childOrderStrategies: [
          {
            ...secondaryOrder,
            orderStrategyType: "SINGLE",
          },
        ],
      },
      {
        ...secondaryOrder,
        orderStrategyType: "SINGLE",
      },
    ],
  };
}

function firstTriggersSecond(
  primaryOrder: Order,
  secondaryOrder: Order,
): CompositeOrder {
  return {
    ...primaryOrder, // Spread primaryOrder into the root object
    orderStrategyType: "TRIGGER", // Override the root strategy type to TRIGGER
    childOrderStrategies: [
      {
        ...secondaryOrder, // Add secondaryOrder to child strategies
      },
    ],
  };
}



================================================
FILE: src/schwab-client-js.ts
================================================
/**
 * @fileoverview This file contains the SchwabAPIclient class, a
 * wrapper around the Schwab API for individual traders.
 * It includes clients for market data, trading operations, and streaming data.
 * @filename schwab-client-js.ts
 * @author Jason Levitt
 */

import "./initenv.js";
import logger from "./logger.js";
import WebSocket from "ws";
import { EventEmitter } from "events";
import endpoint from "./endpoints.js";
import fetchData from "./fetch.js";
import fetchToken from "./access.js";

// Create WeakMap for private credential storage
const _credentials: WeakMap<SchwabAPIclient, Credentials> = new WeakMap();

// Define interfaces for strongly typed data
interface Credentials {
  appKey: string;
  appSecret: string;
  appRefresh: string;
  access_token: string; // Temporary token
  access_exp: number; // Expiration time in seconds since the epoch
}

interface OrderObject {
  [key: string]: any;
}

interface LoginMessage {
  requests: Array<{
    requestid: string;
    service: string;
    command: string;
    SchwabClientCustomerId: string;
    SchwabClientCorrelId: string;
    parameters?: Record<string, any>;
  }>;
}

interface PriceHistoryOptions {
  periodType?: string;
  period?: number;
  frequencyType?: string;
  frequency?: number;
  startDate?: number;
  endDate?: number;
  needExtendedHoursData?: boolean;
  needPreviousClose?: boolean;
}

interface ChainsOptions {
  contractType?: string;
  strikeCount?: number;
  includeUnderlyingQuote?: boolean;
  strategy?: string;
  interval?: number;
  strike?: number;
  range?: string;
  fromDate?: string;
  toDate?: string;
  volatility?: number;
  underlyingPrice?: number;
  interestRate?: number;
  daysToExpiration?: number;
  expMonth?: string;
  optionType?: string;
  entitlement?: string;
}

/**
 * @class SchwabAPIclient
 * @author Jason Levitt
 * @description
 * A class that wraps the Schwab API for individual traders.
 * It contains three subclasses that do all the heavy lifting:
 * MarketApiClient -- read-only market data
 * TradingApiClient -- trading capabilities and account information
 * StreamingApiClient -- real-time streaming of market data
 */
class SchwabAPIclient {
  constructor(
    appKey: string = "",
    appSecret: string = "",
    appRefresh: string = "",
  ) {
    const credentials: Credentials = {
      appKey: process.env.SCHWAB_APP_KEY || appKey,
      appSecret: process.env.SCHWAB_SECRET || appSecret,
      appRefresh: process.env.SCHWAB_REFRESH_TOKEN || appRefresh, // expires every seven days
      access_token: "", // expires every 30 minutes
      access_exp: Math.floor(Date.now() / 1000) + 29 * 60, // expiration is 29 minutes in the future
    };

    if (!credentials.appKey) {
      throw new Error("Your Api Key was not found.");
    }
    if (!credentials.appSecret) {
      throw new Error("Your Secret key was not found.");
    }
    if (!credentials.appRefresh) {
      throw new Error("Your Refresh key was not found.");
    }

    // Store credentials privately in the WeakMap
    _credentials.set(this, credentials);
  }

  /**
   * @method checkAccessToken
   * @description Refreshes the access token if it has expired
   * @param creds {Credentials} - The credentials object containing tokens and expiration
   * @throws {Error} - Throws an error if token refresh fails
   */
  public async checkAccessToken(creds: Credentials): Promise<void> {
    try {
      if (
        creds.access_token === "" ||
        Math.floor(Date.now() / 1000) >= creds.access_exp
      ) {
        const tokens = await fetchToken(creds);
        creds.access_token = tokens.access_token as string;
        creds.access_exp = Math.floor(Date.now() / 1000) + 29 * 60;
      }
    } catch (error) {
      throw new Error(
        `Error: failed to update access token. You may need to run schwab-authorize. Details: ${(error as Error).message}`,
      );
    }
  }
}

/**
 * @description
 * TradingApiClient contains the Schwab methods for doing transactions
 * and getting account information.
 * It is a subclass of SchwabAPIclient which contains the constructor.
 *
 * @class TradingApiClient
 * @extends SchwabAPIclient
 *
 */
class TradingApiClient extends SchwabAPIclient {
  async ordersByAccount(
    accountHash: string,
    fromEnteredTime: string,
    toEnteredTime: string,
    status: string | null = null,
    maxResults: number | null = null,
  ): Promise<any> {
    await this.checkAccessToken(_credentials.get(this)!);

    if (!accountHash || accountHash.trim().length === 0) {
      throw new Error(
        "Error: accountHash parameter is not a string or is empty.",
      );
    }

    const params = new URLSearchParams();
    params.append("fromEnteredTime", fromEnteredTime);
    params.append("toEnteredTime", toEnteredTime);
    if (status) params.append("status", status);
    if (maxResults !== null) params.append("maxResults", maxResults.toString());

    const url = `${endpoint.ORDS(accountHash)}?${params.toString()}`;
    return fetchData(url, {
      type: "GET",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${_credentials.get(this)?.access_token}`,
      },
    });
  }

  async orderById(accountHash: string, orderId: string): Promise<any> {
    await this.checkAccessToken(_credentials.get(this)!);

    if (!accountHash || accountHash.trim().length === 0) {
      throw new Error(
        "Error: accountHash parameter is not a string or is empty.",
      );
    }

    if (!orderId || orderId.trim().length === 0) {
      throw new Error("Error: Order Id parameter is not a string or is empty.");
    }

    const url = endpoint.ORDID(accountHash, orderId);
    return fetchData(url, {
      type: "GET",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${_credentials.get(this)?.access_token}`,
      },
    });
  }

  async orderAll(
    fromEnteredTime: string,
    toEnteredTime: string,
    status: string | null = null,
    maxResults: number | null = null,
  ): Promise<any> {
    await this.checkAccessToken(_credentials.get(this)!);

    const params = new URLSearchParams();
    params.append("fromEnteredTime", fromEnteredTime);
    params.append("toEnteredTime", toEnteredTime);
    if (status) params.append("status", status);
    if (maxResults !== null) params.append("maxResults", maxResults.toString());

    const url = `${endpoint.ORDALL}?${params.toString()}`;
    return fetchData(url, {
      type: "GET",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${_credentials.get(this)?.access_token}`,
      },
    });
  }

  async placeOrderByAcct(
    accountHash: string,
    orderObj: OrderObject,
  ): Promise<any> {
    await this.checkAccessToken(_credentials.get(this)!);

    if (!accountHash || accountHash.trim().length === 0) {
      throw new Error(
        "Error: accountHash parameter is not a string or is empty.",
      );
    }

    if (!orderObj || Object.keys(orderObj).length === 0) {
      throw new Error(
        "Error: Order object parameter is not an object or is empty.",
      );
    }

    const url = endpoint.ORDS(accountHash);
    return fetchData(url, {
      type: "POST",
      headers: {
        "Content-Type": "application/json",
        accept: "application/json",
        Authorization: `Bearer ${_credentials.get(this)?.access_token}`,
      },
      body: JSON.stringify(orderObj) as string,
    });
  }

  async orderDelete(accountHash: string, orderId: number): Promise<any> {
    await this.checkAccessToken(_credentials.get(this)!);

    if (!accountHash || accountHash.trim().length === 0) {
      throw new Error(
        "Error: accountHash parameter is not a string or is empty.",
      );
    }

    if (!orderId) {
      throw new Error("Error: Order Id parameter is missing.");
    }

    const url = endpoint.ORDID(accountHash, orderId.toString());
    return fetchData(url, {
      type: "DELETE",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${_credentials.get(this)?.access_token}`,
      },
    });
  }

  async updateOrderById(
    accountHash: string,
    orderId: number,
    orderObj: OrderObject,
  ): Promise<any> {
    await this.checkAccessToken(_credentials.get(this)!);

    if (!accountHash || accountHash.trim().length === 0) {
      throw new Error(
        "Error: accountHash parameter is not a string or is empty.",
      );
    }

    if (!orderId) {
      throw new Error("Error: Order Id parameter is missing.");
    }

    if (!orderObj || Object.keys(orderObj).length === 0) {
      throw new Error(
        "Error: Order object parameter is not an object or is empty.",
      );
    }

    const url = endpoint.ORDID(accountHash, orderId.toString());

    return fetchData(url, {
      type: "PUT",
      headers: {
        "Content-Type": "application/json",
        accept: "application/json",
        Authorization: `Bearer ${_credentials.get(this)?.access_token}`,
      },
      body: JSON.stringify(orderObj) as string,
    });
  }

  async orderPreview(accountHash: string, orderObj: OrderObject): Promise<any> {
    await this.checkAccessToken(_credentials.get(this)!);

    if (!accountHash || accountHash.trim().length === 0) {
      throw new Error(
        "Error: accountHash parameter is not a string or is empty.",
      );
    }

    if (!orderObj || Object.keys(orderObj).length === 0) {
      throw new Error(
        "Error: Order object parameter is not an object or is empty.",
      );
    }

    const url = endpoint.ORDPREV(accountHash);

    return fetchData(url, {
      type: "POST",
      headers: {
        "Content-Type": "application/json",
        accept: "application/json",
        Authorization: `Bearer ${_credentials.get(this)?.access_token}`,
      },
      body: JSON.stringify(orderObj) as string,
    });
  }

  async accountsNumbers(): Promise<any> {
    await this.checkAccessToken(_credentials.get(this)!);

    const url = endpoint.ACCTNUMS;

    return fetchData(url, {
      type: "GET",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${_credentials.get(this)?.access_token}`,
      },
    });
  }

  async accountsDetails(
    accountHash: string,
    fields: string | null = null,
  ): Promise<any> {
    await this.checkAccessToken(_credentials.get(this)!);

    if (!accountHash || accountHash.trim().length === 0) {
      throw new Error(
        "Error: accountHash parameter is not a string or is empty.",
      );
    }

    const query = fields ? `?fields=${fields}` : "";
    const url = `${endpoint.ACCTDETAILS(accountHash)}${query}`;

    return fetchData(url, {
      type: "GET",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${_credentials.get(this)?.access_token}`,
      },
    });
  }

  async accountsAll(fields: string | null = null): Promise<any> {
    await this.checkAccessToken(_credentials.get(this)!);

    const query = fields ? `?fields=${fields}` : "";
    const url = `${endpoint.ACCTLIST}${query}`;

    return fetchData(url, {
      type: "GET",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${_credentials.get(this)?.access_token}`,
      },
    });
  }

  async transactByAcct(
    accountHash: string,
    types: string,
    startDate: string,
    endDate: string,
    symbol: string | null = null,
  ): Promise<any> {
    await this.checkAccessToken(_credentials.get(this)!);

    const params = new URLSearchParams();
    params.append("types", types);
    params.append("startDate", startDate);
    params.append("endDate", endDate);
    if (symbol) params.append("symbol", symbol);

    const url = `${endpoint.TRANS(accountHash)}?${params.toString()}`;
    return fetchData(url, {
      type: "GET",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${_credentials.get(this)?.access_token}`,
      },
    });
  }

  async transactById(accountHash: string, transId: string): Promise<any> {
    if (!accountHash || accountHash.trim().length === 0) {
      throw new Error(
        "Error: accountHash parameter is not a string or is empty.",
      );
    }

    await this.checkAccessToken(_credentials.get(this)!);

    const url = endpoint.TRANSID(accountHash, transId);

    return fetchData(url, {
      type: "GET",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${_credentials.get(this)?.access_token}`,
      },
    });
  }

  async prefs(): Promise<any> {
    await this.checkAccessToken(_credentials.get(this)!);

    const url = endpoint.PREFS;
    return fetchData(url, {
      type: "GET",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${_credentials.get(this)?.access_token}`,
      },
    });
  }
}

/**
 * @description
 * MarketApiClient contains the Schwab methods for fetching market data.
 * It is a subclass of SchwabAPIclient which contains the constructor.
 *
 * @class MarketApiClient
 * @extends SchwabAPIclient
 *
 */
class MarketApiClient extends SchwabAPIclient {
  async markets(markets: string, date: string | null = null): Promise<any> {
    if (!markets || markets.trim().length === 0) {
      throw new Error("Error: you must specify a list of markets.");
    }

    await this.checkAccessToken(_credentials.get(this)!);

    const params = new URLSearchParams();
    params.append("markets", markets);
    if (date) params.append("date", date);

    const url = `${endpoint.MARKETS}?${params.toString()}`;
    return fetchData(url, {
      type: "GET",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${_credentials.get(this)?.access_token}`,
      },
    });
  }

  async marketById(
    market_id: string,
    date: string | null = null,
  ): Promise<any> {
    if (!market_id || market_id.trim().length === 0) {
      throw new Error("Error: you must specify a market.");
    }

    await this.checkAccessToken(_credentials.get(this)!);

    let url = endpoint.MARKETSID(market_id);

    if (date) {
      const params = new URLSearchParams();
      params.append("date", date);
      url = `${url}?${params.toString()}`;
    }

    return fetchData(url, {
      type: "GET",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${_credentials.get(this)?.access_token}`,
      },
    });
  }

  async instrumentsCusip(cusip_id: string): Promise<any> {
    if (!cusip_id || cusip_id.trim().length === 0) {
      throw new Error("Error: you must specify a cusip_id.");
    }

    await this.checkAccessToken(_credentials.get(this)!);

    const url = endpoint.INSTID(cusip_id);
    return fetchData(url, {
      type: "GET",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${_credentials.get(this)?.access_token}`,
      },
    });
  }

  async instrumentsSymbol(symbol: string, projection: string): Promise<any> {
    if (
      !symbol ||
      symbol.trim().length === 0 ||
      !projection ||
      projection.trim().length === 0
    ) {
      throw new Error("Error: you must specify both a symbol and projection.");
    }

    await this.checkAccessToken(_credentials.get(this)!);

    const params = new URLSearchParams({ symbol, projection });
    const url = `${endpoint.INST}?${params.toString()}`;

    return fetchData(url, {
      type: "GET",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${_credentials.get(this)?.access_token}`,
      },
    });
  }

  async movers(
    symbol_id: string,
    sort: string | null = null,
    frequency: string | null = null,
  ): Promise<any> {
    if (!symbol_id || symbol_id.trim().length === 0) {
      throw new Error(
        "Error: symbol_id parameter is not a string or is empty.",
      );
    }

    await this.checkAccessToken(_credentials.get(this)!);

    const params = new URLSearchParams({ symbol_id });
    if (sort) params.append("sort", sort);
    if (frequency) params.append("frequency", frequency);

    const url = `${endpoint.MOVERS(symbol_id)}?${params.toString()}`;
    return fetchData(url, {
      type: "GET",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${_credentials.get(this)?.access_token}`,
      },
    });
  }

  async priceHistory(
    symbol: string,
    options: PriceHistoryOptions = {},
  ): Promise<any> {
    if (!symbol || symbol.trim().length === 0) {
      throw new Error("Error: symbol parameter is not a string or is empty.");
    }

    await this.checkAccessToken(_credentials.get(this)!);

    const params = new URLSearchParams({ symbol });

    for (const [key, value] of Object.entries(options)) {
      if (value) params.append(key, value);
    }

    const url = `${endpoint.PRICEHIST}?${params.toString()}`;
    return fetchData(url, {
      type: "GET",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${_credentials.get(this)?.access_token}`,
      },
    });
  }

  async expirationChain(symbol: string): Promise<any> {
    if (!symbol || symbol.trim().length === 0) {
      throw new Error("Error: symbol parameter is not a string or is empty.");
    }

    await this.checkAccessToken(_credentials.get(this)!);

    const url = `${endpoint.CHAINSEXP}?symbol=${symbol}`;

    const data = await fetchData(url, {
      type: "GET",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${_credentials.get(this)?.access_token}`,
      },
    });

    return data;
  }

  async chains(symbol: string, options: ChainsOptions = {}): Promise<any> {
    if (typeof symbol !== "string" || symbol.trim().length === 0) {
      throw new Error("Error: symbol parameter is not a string or is empty.");
    }

    // Ensure credentials exist and check access token
    await this.checkAccessToken(_credentials.get(this)!);

    // Initialize query parameters
    const params = new URLSearchParams();
    params.append("symbol", symbol);

    // Add optional parameters if they are provided
    for (const [key, value] of Object.entries(options)) {
      if (value !== null && value !== undefined) {
        params.append(key, value.toString());
      }
    }

    // Construct the final query string
    const query = params.toString();
    const url = `${endpoint.CHAINS}?${query}`;

    // Fetch data and return the response
    const data = await fetchData(url, {
      type: "GET",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${_credentials.get(this)?.access_token}`,
      },
    });

    return data;
  }

  async quoteById(
    symbol_id: string,
    fields: string | null = null,
  ): Promise<any> {
    await this.checkAccessToken(_credentials.get(this)!);

    const params = new URLSearchParams();
    if (fields) params.append("fields", fields);

    const url = `${endpoint.QUOTEID(symbol_id)}?${params.toString()}`;

    const data = await fetchData(url, {
      type: "GET",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${_credentials.get(this)?.access_token}`,
      },
    });

    return data;
  }

  async quotes(
    symbols: string,
    fields: string | null = null,
    indicative: string | null = null,
  ): Promise<any> {
    await this.checkAccessToken(_credentials.get(this)!);

    const params = new URLSearchParams();
    params.append("symbols", symbols);
    if (fields) params.append("fields", fields);
    if (indicative) params.append("indicative", indicative);

    const url = `${endpoint.QUOTES}?${params.toString()}`;

    const data = await fetchData(url, {
      type: "GET",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${_credentials.get(this)?.access_token}`,
      },
    });

    return data;
  }
}

/**
 * @description
 * StreamingApiClient contains the Schwab methods for streaming
 * market data
 * It is a subclass of SchwabAPIclient which contains the constructor.
 *
 * @class StreamingApiClient
 * @extends SchwabAPIclient
 *
 */
class StreamingApiClient extends SchwabAPIclient {
  private streamEvents: EventEmitter;
  private stream: WebSocket | null;
  private counterId: number;
  private customerId: string;
  private correlId: string;
  private channel: string;
  private functionId: string;
  private streamUrl: string;

  constructor(
    appKey: string = "",
    appSecret: string = "",
    appRefresh: string = "",
  ) {
    super(appKey, appSecret, appRefresh);
    this.streamEvents = new EventEmitter();
    this.stream = null;
    this.counterId = 0;
    this.customerId = "";
    this.correlId = "";
    this.channel = "";
    this.functionId = "";
    this.streamUrl = "";
  }

  private generateRequestMessage(
    command: string,
    service: string,
    params: Record<string, any> = {},
  ): LoginMessage {
    return {
      requests: [
        {
          requestid: `${++this.counterId}`,
          service: service.toUpperCase(),
          command: command.toUpperCase(),
          SchwabClientCustomerId: this.customerId,
          SchwabClientCorrelId: this.correlId,
          ...(Object.keys(params).length > 0 && { parameters: { ...params } }),
        },
      ],
    };
  }

  private async generateLoginMessage(): Promise<LoginMessage> {
    await this.checkAccessToken(_credentials.get(this)!);

    return {
      requests: [
        {
          requestid: `${++this.counterId}`,
          service: "ADMIN",
          command: "LOGIN",
          SchwabClientCustomerId: this.customerId,
          SchwabClientCorrelId: this.correlId,
          parameters: {
            Authorization: _credentials.get(this)?.access_token,
            SchwabClientChannel: this.channel,
            SchwabClientFunctionId: this.functionId,
          },
        },
      ],
    };
  }

  private async generateLogoutMessage(): Promise<LoginMessage> {
    await this.checkAccessToken(_credentials.get(this)!);

    return {
      requests: [
        {
          requestid: `${++this.counterId}`,
          service: "ADMIN",
          command: "LOGOUT",
          SchwabClientCustomerId: this.customerId,
          SchwabClientCorrelId: this.correlId,
        },
      ],
    };
  }

  async streamInit(): Promise<void> {
    try {
      const trading = new TradingApiClient();
      const data = await trading.prefs();

      this.streamUrl = data.streamerInfo[0].streamerSocketUrl;
      this.customerId = data.streamerInfo[0].schwabClientCustomerId;
      this.correlId = data.streamerInfo[0].schwabClientCorrelId;
      this.channel = data.streamerInfo[0].schwabClientChannel;
      this.functionId = data.streamerInfo[0].schwabClientFunctionId;

      this.stream = new WebSocket(this.streamUrl);

      this.stream.on("open", () => this.streamEvents.emit("open"));
      this.stream.on("close", (code, reason) =>
        this.streamEvents.emit(
          "close",
          code,
          reason?.toString() || "No reason provided",
        ),
      );
      this.stream.on("error", (error) =>
        this.streamEvents.emit("error", error),
      );
      this.stream.on("message", (message) => {
        const strmessage = Buffer.isBuffer(message)
          ? message.toString("utf8")
          : message.toString();
        this.streamEvents.emit("message", strmessage);
      });

      await new Promise<void>((resolve, reject) => {
        this.stream?.on("open", resolve);
        this.stream?.on("error", reject);
      });
      logger(
        "streaming",
        "msgs",
        "Websocket connectiom established:",
        this.streamUrl,
      );
    } catch (error) {
      throw new Error(`Error initializing stream: ${(error as Error).message}`);
    }
  }

  async streamSchwabLogin(): Promise<any> {
    const loginMsg = await this.generateLoginMessage();

    if (this.stream && this.stream.readyState === WebSocket.OPEN) {
      return new Promise<any>((resolve, reject) => {
        const messageHandler = (message: WebSocket.RawData) => {
          try {
            const strmessage = Buffer.isBuffer(message)
              ? JSON.parse(message.toString("utf8"))
              : JSON.parse(message.toString());
            // Check for array
            if (!Array.isArray(strmessage.response)) {
              reject(
                new Error(
                  "Expected array in LOGIN response: 'response' is not an array",
                ),
              );
            }
            if (strmessage.response[0]?.content?.code === 0) {
              logger(
                "streaming",
                "msgs",
                "LOGIN to websocket succeeded: ",
                JSON.stringify(strmessage),
              );
              resolve(strmessage);
            } else {
              reject(
                new Error(
                  `Login failed with code = ${strmessage.response[0]?.content?.code}`,
                ),
              );
            }
            this.stream?.removeListener("message", messageHandler);
          } catch (error) {
            reject(error);
          }
        };

        if (this.stream) {
          this.stream.on("message", messageHandler);
          logger(
            "streaming",
            "msgs",
            "LOGIN message:",
            JSON.stringify(loginMsg),
          );
          this.stream.send(JSON.stringify(loginMsg));
        } else {
          throw new Error("WebSocket stream is not initialized.");
        }
        logger(
          "streaming",
          "msgs",
          "Sent LOGIN message:",
          JSON.stringify(loginMsg),
        );

        setTimeout(() => {
          this.stream?.removeListener("message", messageHandler);
          reject(new Error("Timeout: No response received"));
        }, 5000);
      });
    } else {
      throw new Error("WebSocket is not open.");
    }
  }

  async streamSchwabLogout(): Promise<void> {
    const logoutMsg = await this.generateLogoutMessage();
    if (this.stream && this.stream.readyState === WebSocket.OPEN) {
      this.stream.send(JSON.stringify(logoutMsg));
      logger(
        "streaming",
        "msgs",
        "Sent LOGOUT message: ",
        JSON.stringify(logoutMsg),
      );
    } else {
      throw new Error("No message sent. WebSocket is not open.");
    }
  }

  streamSchwabRequest(
    command: string,
    service: string,
    params: Record<string, any> = {},
  ): void {
    const requestMsg = this.generateRequestMessage(command, service, params);
    if (this.stream && this.stream.readyState === WebSocket.OPEN) {
      this.stream.send(JSON.stringify(requestMsg));
      logger(
        "streaming",
        "msgs",
        "Sent request message: ",
        JSON.stringify(requestMsg),
      );
    } else {
      throw new Error("No message sent. WebSocket is not open.");
    }
  }

  streamListen(eventName: string, listener: (...args: any[]) => void): void {
    this.streamEvents.on(eventName, (...args: any[]) => {
      // Log the received message
      logger(
        "streaming",
        "msgs",
        `Received message for event: ${eventName}`,
        args,
      );

      // Call the original listener with the received arguments
      listener(...args);
    });
  }

  streamClose(): void {
    logger("streaming", "msgs", "Closing websocket stream.");
    if (this.stream) {
      this.stream.close();
    } else {
      throw new Error("WebSocket is closed or does not exist.");
    }
  }
}

export { MarketApiClient, TradingApiClient, StreamingApiClient };


