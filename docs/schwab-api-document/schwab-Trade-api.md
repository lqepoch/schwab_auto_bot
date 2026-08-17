Charles Schwab Logo
Developer Portal
Home
API Products
User Guides

Individual Developer
Dashboard
Profile
Sign Out
Home
API Products
User Guides

Individual Developer
Dashboard
Profile
Sign Out
API Products
Trader API - Individual
Accounts and Trading Production
Accounts and Trading Production
Specifications
Documentation
APIs to access Account Balances & Positions, to perform trading activities
Trader API - Account Access and User Preferences
1.0.0
OAS3
Schwab Trader API access to Account, Order entry and User Preferences

Contact Schwab Trader API team
Servers

https://api.schwabapi.com/trader/v1
Accounts


GET
/accounts/accountNumbers
Get list of account numbers and their encrypted values

Account numbers in plain text cannot be used outside of headers or request/response bodies. As the first step consumers must invoke this service to retrieve the list of plain text/encrypted value pairs, and use encrypted account values for all subsequent calls for any accountNumber request.

Parameters
No parameters

Responses
Code	Description	Links
200
List of valid "accounts", matching the provided input parameters.

Media type

application/json
Controls Accept header.
Example Value
Schema
[
{
"accountNumber": "string",
"hashValue": "string"
}
]
Headers:
Name	Description	Type
Schwab-Client-CorrelId
Correlation Id. Auto generated

string
No links
400
An error message indicating the validation problem with the request.

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
401
An error message indicating either authorization token is invalid or there are no accounts the caller is allowed to view or use for trading that are registered with the provided third party application

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
403
An error message indicating the caller is forbidden from accessing this service

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
404
An error message indicating the resource is not found

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
500
An error message indicating there was an unexpected server error

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
503
An error message indicating server has a temporary problem responding

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links

GET
/accounts
Get linked account(s) balances and positions for the logged in user.

All the linked account information for the user logged in. The balances on these accounts are displayed by default however the positions on these accounts will be displayed based on the "positions" flag.

Parameters
Name	Description
fields
string
(query)
This allows one to determine which fields they want returned. Possible value in this String can be:
positions
Example:
fields=positions

fields
Responses
Code	Description	Links
200
List of valid "accounts", matching the provided input parameters.

Media type

application/json
Controls Accept header.
Example Value
Schema
[
{
"securitiesAccount": {
"accountNumber": "string",
"roundTrips": 0,
"isDayTrader": false,
"isClosingOnlyRestricted": false,
"pfcbFlag": false,
"positions": [
{
"shortQuantity": 0,
"averagePrice": 0,
"currentDayProfitLoss": 0,
"currentDayProfitLossPercentage": 0,
"longQuantity": 0,
"settledLongQuantity": 0,
"settledShortQuantity": 0,
"agedQuantity": 0,
"instrument": {
"cusip": "string",
"symbol": "string",
"description": "string",
"instrumentId": 0,
"netChange": 0,
"type": "SWEEP_VEHICLE"
},
"marketValue": 0,
"maintenanceRequirement": 0,
"averageLongPrice": 0,
"averageShortPrice": 0,
"taxLotAverageLongPrice": 0,
"taxLotAverageShortPrice": 0,
"longOpenProfitLoss": 0,
"shortOpenProfitLoss": 0,
"previousSessionLongQuantity": 0,
"previousSessionShortQuantity": 0,
"currentDayCost": 0
}
],
"initialBalances": {
"accruedInterest": 0,
"availableFundsNonMarginableTrade": 0,
"bondValue": 0,
"buyingPower": 0,
"cashBalance": 0,
"cashAvailableForTrading": 0,
"cashReceipts": 0,
"dayTradingBuyingPower": 0,
"dayTradingBuyingPowerCall": 0,
"dayTradingEquityCall": 0,
"equity": 0,
"equityPercentage": 0,
"liquidationValue": 0,
"longMarginValue": 0,
"longOptionMarketValue": 0,
"longStockValue": 0,
"maintenanceCall": 0,
"maintenanceRequirement": 0,
"margin": 0,
"marginEquity": 0,
"moneyMarketFund": 0,
"mutualFundValue": 0,
"regTCall": 0,
"shortMarginValue": 0,
"shortOptionMarketValue": 0,
"shortStockValue": 0,
"totalCash": 0,
"isInCall": 0,
"unsettledCash": 0,
"pendingDeposits": 0,
"marginBalance": 0,
"shortBalance": 0,
"accountValue": 0
},
"currentBalances": {
"availableFunds": 0,
"availableFundsNonMarginableTrade": 0,
"buyingPower": 0,
"buyingPowerNonMarginableTrade": 0,
"dayTradingBuyingPower": 0,
"dayTradingBuyingPowerCall": 0,
"equity": 0,
"equityPercentage": 0,
"longMarginValue": 0,
"maintenanceCall": 0,
"maintenanceRequirement": 0,
"marginBalance": 0,
"regTCall": 0,
"shortBalance": 0,
"shortMarginValue": 0,
"sma": 0,
"isInCall": 0,
"stockBuyingPower": 0,
"optionBuyingPower": 0
},
"projectedBalances": {
"availableFunds": 0,
"availableFundsNonMarginableTrade": 0,
"buyingPower": 0,
"buyingPowerNonMarginableTrade": 0,
"dayTradingBuyingPower": 0,
"dayTradingBuyingPowerCall": 0,
"equity": 0,
"equityPercentage": 0,
"longMarginValue": 0,
"maintenanceCall": 0,
"maintenanceRequirement": 0,
"marginBalance": 0,
"regTCall": 0,
"shortBalance": 0,
"shortMarginValue": 0,
"sma": 0,
"isInCall": 0,
"stockBuyingPower": 0,
"optionBuyingPower": 0
}
}
}
]
Headers:
Name	Description	Type
Schwab-Client-CorrelId
Correlation Id. Auto generated

string
No links
400
An error message indicating the validation problem with the request.

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
401
An error message indicating either authorization token is invalid or there are no accounts the caller is allowed to view or use for trading that are registered with the provided third party application

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
403
An error message indicating the caller is forbidden from accessing this service

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
404
An error message indicating the resource is not found

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
500
An error message indicating there was an unexpected server error

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
503
An error message indicating server has a temporary problem responding

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links

GET
/accounts/{accountNumber}
Get a specific account balance and positions for the logged in user.

Specific account information with balances and positions. The balance information on these accounts is displayed by default but Positions will be returned based on the "positions" flag.

Parameters
Name	Description
accountNumber *
string
(path)
The encrypted ID of the account

accountNumber
fields
string
(query)
This allows one to determine which fields they want returned. Possible values in this String can be:
positions
Example:
fields=positions

fields
Responses
Code	Description	Links
200
A valid account, matching the provided input parameters

Media type

application/json
Controls Accept header.
Example Value
Schema
{
"securitiesAccount": {
"accountNumber": "string",
"roundTrips": 0,
"isDayTrader": false,
"isClosingOnlyRestricted": false,
"pfcbFlag": false,
"positions": [
{
"shortQuantity": 0,
"averagePrice": 0,
"currentDayProfitLoss": 0,
"currentDayProfitLossPercentage": 0,
"longQuantity": 0,
"settledLongQuantity": 0,
"settledShortQuantity": 0,
"agedQuantity": 0,
"instrument": {
"cusip": "string",
"symbol": "string",
"description": "string",
"instrumentId": 0,
"netChange": 0,
"type": "SWEEP_VEHICLE"
},
"marketValue": 0,
"maintenanceRequirement": 0,
"averageLongPrice": 0,
"averageShortPrice": 0,
"taxLotAverageLongPrice": 0,
"taxLotAverageShortPrice": 0,
"longOpenProfitLoss": 0,
"shortOpenProfitLoss": 0,
"previousSessionLongQuantity": 0,
"previousSessionShortQuantity": 0,
"currentDayCost": 0
}
],
"initialBalances": {
"accruedInterest": 0,
"availableFundsNonMarginableTrade": 0,
"bondValue": 0,
"buyingPower": 0,
"cashBalance": 0,
"cashAvailableForTrading": 0,
"cashReceipts": 0,
"dayTradingBuyingPower": 0,
"dayTradingBuyingPowerCall": 0,
"dayTradingEquityCall": 0,
"equity": 0,
"equityPercentage": 0,
"liquidationValue": 0,
"longMarginValue": 0,
"longOptionMarketValue": 0,
"longStockValue": 0,
"maintenanceCall": 0,
"maintenanceRequirement": 0,
"margin": 0,
"marginEquity": 0,
"moneyMarketFund": 0,
"mutualFundValue": 0,
"regTCall": 0,
"shortMarginValue": 0,
"shortOptionMarketValue": 0,
"shortStockValue": 0,
"totalCash": 0,
"isInCall": 0,
"unsettledCash": 0,
"pendingDeposits": 0,
"marginBalance": 0,
"shortBalance": 0,
"accountValue": 0
},
"currentBalances": {
"availableFunds": 0,
"availableFundsNonMarginableTrade": 0,
"buyingPower": 0,
"buyingPowerNonMarginableTrade": 0,
"dayTradingBuyingPower": 0,
"dayTradingBuyingPowerCall": 0,
"equity": 0,
"equityPercentage": 0,
"longMarginValue": 0,
"maintenanceCall": 0,
"maintenanceRequirement": 0,
"marginBalance": 0,
"regTCall": 0,
"shortBalance": 0,
"shortMarginValue": 0,
"sma": 0,
"isInCall": 0,
"stockBuyingPower": 0,
"optionBuyingPower": 0
},
"projectedBalances": {
"availableFunds": 0,
"availableFundsNonMarginableTrade": 0,
"buyingPower": 0,
"buyingPowerNonMarginableTrade": 0,
"dayTradingBuyingPower": 0,
"dayTradingBuyingPowerCall": 0,
"equity": 0,
"equityPercentage": 0,
"longMarginValue": 0,
"maintenanceCall": 0,
"maintenanceRequirement": 0,
"marginBalance": 0,
"regTCall": 0,
"shortBalance": 0,
"shortMarginValue": 0,
"sma": 0,
"isInCall": 0,
"stockBuyingPower": 0,
"optionBuyingPower": 0
}
}
}
Headers:
Name	Description	Type
Schwab-Client-CorrelId
Correlation Id. Auto generated

string
No links
400
An error message indicating the validation problem with the request.

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
401
An error message indicating either authorization token is invalid or there are no accounts the caller is allowed to view or use for trading that are registered with the provided third party application

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
403
An error message indicating the caller is forbidden from accessing this service

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
404
An error message indicating the resource is not found

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
500
An error message indicating there was an unexpected server error

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
503
An error message indicating server has a temporary problem responding

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
Orders


GET
/accounts/{accountNumber}/orders
Get all orders for a specific account.

All orders for a specific account. Orders retrieved can be filtered based on input parameters below. Maximum date range is 1 year.

Parameters
Name	Description
accountNumber *
string
(path)
The encrypted ID of the account

accountNumber
maxResults
integer($int64)
(query)
The max number of orders to retrieve. Default is 3000.

maxResults
fromEnteredTime *
string
(query)
Specifies that no orders entered before this time should be returned. Valid ISO-8601 formats are :
yyyy-MM-dd'T'HH:mm:ss.SSSZ Example fromEnteredTime is '2024-03-29T00:00:00.000Z'. 'toEnteredTime' must also be set.

fromEnteredTime
toEnteredTime *
string
(query)
Specifies that no orders entered after this time should be returned.Valid ISO-8601 formats are :
yyyy-MM-dd'T'HH:mm:ss.SSSZ. Example toEnteredTime is '2024-04-28T23:59:59.000Z'. 'fromEnteredTime' must also be set.

toEnteredTime
status
string
(query)
Specifies that only orders of this status should be returned.

Available values : AWAITING_PARENT_ORDER, AWAITING_CONDITION, AWAITING_STOP_CONDITION, AWAITING_MANUAL_REVIEW, ACCEPTED, AWAITING_UR_OUT, PENDING_ACTIVATION, QUEUED, WORKING, REJECTED, PENDING_CANCEL, CANCELED, PENDING_REPLACE, REPLACED, FILLED, EXPIRED, NEW, AWAITING_RELEASE_TIME, PENDING_ACKNOWLEDGEMENT, PENDING_RECALL, UNKNOWN


--
Responses
Code	Description	Links
200
A List of orders for the account, matching the provided input parameters

Media type

application/json
Controls Accept header.
Example Value
Schema
[
{
"session": "NORMAL",
"duration": "DAY",
"orderType": "MARKET",
"cancelTime": "2025-09-18T12:38:10.318Z",
"complexOrderStrategyType": "NONE",
"quantity": 0,
"filledQuantity": 0,
"remainingQuantity": 0,
"requestedDestination": "INET",
"destinationLinkName": "string",
"releaseTime": "2025-09-18T12:38:10.318Z",
"stopPrice": 0,
"stopPriceLinkBasis": "MANUAL",
"stopPriceLinkType": "VALUE",
"stopPriceOffset": 0,
"stopType": "STANDARD",
"priceLinkBasis": "MANUAL",
"priceLinkType": "VALUE",
"price": 0,
"taxLotMethod": "FIFO",
"orderLegCollection": [
{
"orderLegType": "EQUITY",
"legId": 0,
"instrument": {
"cusip": "string",
"symbol": "string",
"description": "string",
"instrumentId": 0,
"netChange": 0,
"type": "SWEEP_VEHICLE"
},
"instruction": "BUY",
"positionEffect": "OPENING",
"quantity": 0,
"quantityType": "ALL_SHARES",
"divCapGains": "REINVEST",
"toSymbol": "string"
}
],
"activationPrice": 0,
"specialInstruction": "ALL_OR_NONE",
"orderStrategyType": "SINGLE",
"orderId": 0,
"cancelable": false,
"editable": false,
"status": "AWAITING_PARENT_ORDER",
"enteredTime": "2025-09-18T12:38:10.318Z",
"closeTime": "2025-09-18T12:38:10.318Z",
"tag": "string",
"accountNumber": 0,
"orderActivityCollection": [
{
"activityType": "EXECUTION",
"executionType": "FILL",
"quantity": 0,
"orderRemainingQuantity": 0,
"executionLegs": [
{
"legId": 0,
"price": 0,
"quantity": 0,
"mismarkedQuantity": 0,
"instrumentId": 0,
"time": "2025-09-18T12:38:10.318Z"
}
]
}
],
"replacingOrderCollection": [
"string"
],
"childOrderStrategies": [
"string"
],
"statusDescription": "string"
}
]
Headers:
Name	Description	Type
Schwab-Client-CorrelId
Correlation Id. Auto generated

string
No links
400
An error message indicating the validation problem with the request.

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
401
An error message indicating either authorization token is invalid or there are no accounts the caller is allowed to view or use for trading that are registered with the provided third party application

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
403
An error message indicating the caller is forbidden from accessing this service

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
404
An error message indicating the resource is not found

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
500
An error message indicating there was an unexpected server error

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
503
An error message indicating server has a temporary problem responding

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links

POST
/accounts/{accountNumber}/orders
Place order for a specific account.

Place an order for a specific account.

Parameters
Name	Description
accountNumber *
string
(path)
The encrypted ID of the account

accountNumber
Request body

application/json
The new Order Object.

Example Value
Schema
{
"session": "NORMAL",
"duration": "DAY",
"orderType": "MARKET",
"cancelTime": "2025-09-18T12:38:10.322Z",
"complexOrderStrategyType": "NONE",
"quantity": 0,
"filledQuantity": 0,
"remainingQuantity": 0,
"destinationLinkName": "string",
"releaseTime": "2025-09-18T12:38:10.322Z",
"stopPrice": 0,
"stopPriceLinkBasis": "MANUAL",
"stopPriceLinkType": "VALUE",
"stopPriceOffset": 0,
"stopType": "STANDARD",
"priceLinkBasis": "MANUAL",
"priceLinkType": "VALUE",
"price": 0,
"taxLotMethod": "FIFO",
"orderLegCollection": [
{
"orderLegType": "EQUITY",
"legId": 0,
"instrument": {
"cusip": "string",
"symbol": "string",
"description": "string",
"instrumentId": 0,
"netChange": 0,
"type": "SWEEP_VEHICLE"
},
"instruction": "BUY",
"positionEffect": "OPENING",
"quantity": 0,
"quantityType": "ALL_SHARES",
"divCapGains": "REINVEST",
"toSymbol": "string"
}
],
"activationPrice": 0,
"specialInstruction": "ALL_OR_NONE",
"orderStrategyType": "SINGLE",
"orderId": 0,
"cancelable": false,
"editable": false,
"status": "AWAITING_PARENT_ORDER",
"enteredTime": "2025-09-18T12:38:10.322Z",
"closeTime": "2025-09-18T12:38:10.322Z",
"accountNumber": 0,
"orderActivityCollection": [
{
"activityType": "EXECUTION",
"executionType": "FILL",
"quantity": 0,
"orderRemainingQuantity": 0,
"executionLegs": [
{
"legId": 0,
"price": 0,
"quantity": 0,
"mismarkedQuantity": 0,
"instrumentId": 0,
"time": "2025-09-18T12:38:10.322Z"
}
]
}
],
"replacingOrderCollection": [
"string"
],
"childOrderStrategies": [
"string"
],
"statusDescription": "string"
}
Responses
Code	Description	Links
201
Empty response body if an order was successfully placed/created.

Media type
Controls Accept header.
Headers:
Name	Description	Type
Schwab-Client-CorrelId
Correlation Id. Auto generated

string
Location
Link to the newly created order if order was successfully created.

string
No links
400
An error message indicating the validation problem with the request.

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
401
An error message indicating either authorization token is invalid or there are no accounts the caller is allowed to view or use for trading that are registered with the provided third party application

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
403
An error message indicating the caller is forbidden from accessing this service

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
404
An error message indicating the resource is not found

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
500
An error message indicating there was an unexpected server error

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
503
An error message indicating server has a temporary problem responding

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links

GET
/accounts/{accountNumber}/orders/{orderId}
Get a specific order by its ID, for a specific account

Get a specific order by its ID, for a specific account

Parameters
Name	Description
accountNumber *
string
(path)
The encrypted ID of the account

accountNumber
orderId *
integer($int64)
(path)
The ID of the order being retrieved.

orderId
Responses
Code	Description	Links
200
An order object, matching the input parameters

Media type

application/json
Controls Accept header.
Example Value
Schema
{
"session": "NORMAL",
"duration": "DAY",
"orderType": "MARKET",
"cancelTime": "2025-09-18T12:38:10.328Z",
"complexOrderStrategyType": "NONE",
"quantity": 0,
"filledQuantity": 0,
"remainingQuantity": 0,
"requestedDestination": "INET",
"destinationLinkName": "string",
"releaseTime": "2025-09-18T12:38:10.328Z",
"stopPrice": 0,
"stopPriceLinkBasis": "MANUAL",
"stopPriceLinkType": "VALUE",
"stopPriceOffset": 0,
"stopType": "STANDARD",
"priceLinkBasis": "MANUAL",
"priceLinkType": "VALUE",
"price": 0,
"taxLotMethod": "FIFO",
"orderLegCollection": [
{
"orderLegType": "EQUITY",
"legId": 0,
"instrument": {
"cusip": "string",
"symbol": "string",
"description": "string",
"instrumentId": 0,
"netChange": 0,
"type": "SWEEP_VEHICLE"
},
"instruction": "BUY",
"positionEffect": "OPENING",
"quantity": 0,
"quantityType": "ALL_SHARES",
"divCapGains": "REINVEST",
"toSymbol": "string"
}
],
"activationPrice": 0,
"specialInstruction": "ALL_OR_NONE",
"orderStrategyType": "SINGLE",
"orderId": 0,
"cancelable": false,
"editable": false,
"status": "AWAITING_PARENT_ORDER",
"enteredTime": "2025-09-18T12:38:10.328Z",
"closeTime": "2025-09-18T12:38:10.328Z",
"tag": "string",
"accountNumber": 0,
"orderActivityCollection": [
{
"activityType": "EXECUTION",
"executionType": "FILL",
"quantity": 0,
"orderRemainingQuantity": 0,
"executionLegs": [
{
"legId": 0,
"price": 0,
"quantity": 0,
"mismarkedQuantity": 0,
"instrumentId": 0,
"time": "2025-09-18T12:38:10.328Z"
}
]
}
],
"replacingOrderCollection": [
"string"
],
"childOrderStrategies": [
"string"
],
"statusDescription": "string"
}
Headers:
Name	Description	Type
Schwab-Client-CorrelId
Correlation Id. Auto generated

string
No links
400
An error message indicating the validation problem with the request.

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
401
An error message indicating either authorization token is invalid or there are no accounts the caller is allowed to view or use for trading that are registered with the provided third party application

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
403
An error message indicating the caller is forbidden from accessing this service

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
404
An error message indicating the resource is not found

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
500
An error message indicating there was an unexpected server error

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
503
An error message indicating server has a temporary problem responding

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links

DELETE
/accounts/{accountNumber}/orders/{orderId}
Cancel an order for a specific account

Cancel a specific order for a specific account

Parameters
Name	Description
accountNumber *
string
(path)
The encrypted ID of the account

accountNumber
orderId *
integer($int64)
(path)
The ID of the order being cancelled

orderId
Responses
Code	Description	Links
200
Empty response body if an order was successfully canceled.

Media type
Controls Accept header.
Headers:
Name	Description	Type
Schwab-Client-CorrelId
Correlation Id. Auto generated

string
No links
400
An error message indicating the validation problem with the request.

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
401
An error message indicating either authorization token is invalid or there are no accounts the caller is allowed to view or use for trading that are registered with the provided third party application

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
403
An error message indicating the caller is forbidden from accessing this service

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
404
An error message indicating the resource is not found

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
500
An error message indicating there was an unexpected server error

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
503
An error message indicating server has a temporary problem responding

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links

PUT
/accounts/{accountNumber}/orders/{orderId}
Replace order for a specific account

Replace an existing order for an account. The existing order will be replaced by the new order. Once replaced, the old order will be canceled and a new order will be created.

Parameters
Name	Description
accountNumber *
string
(path)
The encrypted ID of the account

accountNumber
orderId *
integer($int64)
(path)
The ID of the order being retrieved.

orderId
Request body

application/json
The Order Object.

Example Value
Schema
{
"session": "NORMAL",
"duration": "DAY",
"orderType": "MARKET",
"cancelTime": "2025-09-18T12:38:10.336Z",
"complexOrderStrategyType": "NONE",
"quantity": 0,
"filledQuantity": 0,
"remainingQuantity": 0,
"destinationLinkName": "string",
"releaseTime": "2025-09-18T12:38:10.336Z",
"stopPrice": 0,
"stopPriceLinkBasis": "MANUAL",
"stopPriceLinkType": "VALUE",
"stopPriceOffset": 0,
"stopType": "STANDARD",
"priceLinkBasis": "MANUAL",
"priceLinkType": "VALUE",
"price": 0,
"taxLotMethod": "FIFO",
"orderLegCollection": [
{
"orderLegType": "EQUITY",
"legId": 0,
"instrument": {
"cusip": "string",
"symbol": "string",
"description": "string",
"instrumentId": 0,
"netChange": 0,
"type": "SWEEP_VEHICLE"
},
"instruction": "BUY",
"positionEffect": "OPENING",
"quantity": 0,
"quantityType": "ALL_SHARES",
"divCapGains": "REINVEST",
"toSymbol": "string"
}
],
"activationPrice": 0,
"specialInstruction": "ALL_OR_NONE",
"orderStrategyType": "SINGLE",
"orderId": 0,
"cancelable": false,
"editable": false,
"status": "AWAITING_PARENT_ORDER",
"enteredTime": "2025-09-18T12:38:10.336Z",
"closeTime": "2025-09-18T12:38:10.336Z",
"accountNumber": 0,
"orderActivityCollection": [
{
"activityType": "EXECUTION",
"executionType": "FILL",
"quantity": 0,
"orderRemainingQuantity": 0,
"executionLegs": [
{
"legId": 0,
"price": 0,
"quantity": 0,
"mismarkedQuantity": 0,
"instrumentId": 0,
"time": "2025-09-18T12:38:10.336Z"
}
]
}
],
"replacingOrderCollection": [
"string"
],
"childOrderStrategies": [
"string"
],
"statusDescription": "string"
}
Responses
Code	Description	Links
201
Empty response body if an order was successfully replaced/created.

Media type
Controls Accept header.
Headers:
Name	Description	Type
Schwab-Client-CorrelId
Correlation Id. Auto generated

string
Location
Link to the newly created order if order was successfully created.

string
No links
400
An error message indicating the validation problem with the request.

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
401
An error message indicating either authorization token is invalid or there are no accounts the caller is allowed to view or use for trading that are registered with the provided third party application

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
403
An error message indicating the caller is forbidden from accessing this service

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
404
An error message indicating the resource is not found

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
500
An error message indicating there was an unexpected server error

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
503
An error message indicating server has a temporary problem responding

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links

GET
/orders
Get all orders for all accounts

Get all orders for all accounts

Parameters
Name	Description
maxResults
integer($int64)
(query)
The max number of orders to retrieve. Default is 3000.

maxResults
fromEnteredTime *
string
(query)
Specifies that no orders entered before this time should be returned. Valid ISO-8601 formats are- yyyy-MM-dd'T'HH:mm:ss.SSSZ Date must be within 60 days from today's date. 'toEnteredTime' must also be set.

fromEnteredTime
toEnteredTime *
string
(query)
Specifies that no orders entered after this time should be returned.Valid ISO-8601 formats are - yyyy-MM-dd'T'HH:mm:ss.SSSZ. 'fromEnteredTime' must also be set.

toEnteredTime
status
string
(query)
Specifies that only orders of this status should be returned.

Available values : AWAITING_PARENT_ORDER, AWAITING_CONDITION, AWAITING_STOP_CONDITION, AWAITING_MANUAL_REVIEW, ACCEPTED, AWAITING_UR_OUT, PENDING_ACTIVATION, QUEUED, WORKING, REJECTED, PENDING_CANCEL, CANCELED, PENDING_REPLACE, REPLACED, FILLED, EXPIRED, NEW, AWAITING_RELEASE_TIME, PENDING_ACKNOWLEDGEMENT, PENDING_RECALL, UNKNOWN


--
Responses
Code	Description	Links
200
A List of orders for the specified account or if its not mentioned, for all the linked accounts, matching the provided input parameters.

Media type

application/json
Controls Accept header.
Example Value
Schema
[
{
"session": "NORMAL",
"duration": "DAY",
"orderType": "MARKET",
"cancelTime": "2025-09-18T12:38:10.341Z",
"complexOrderStrategyType": "NONE",
"quantity": 0,
"filledQuantity": 0,
"remainingQuantity": 0,
"requestedDestination": "INET",
"destinationLinkName": "string",
"releaseTime": "2025-09-18T12:38:10.341Z",
"stopPrice": 0,
"stopPriceLinkBasis": "MANUAL",
"stopPriceLinkType": "VALUE",
"stopPriceOffset": 0,
"stopType": "STANDARD",
"priceLinkBasis": "MANUAL",
"priceLinkType": "VALUE",
"price": 0,
"taxLotMethod": "FIFO",
"orderLegCollection": [
{
"orderLegType": "EQUITY",
"legId": 0,
"instrument": {
"cusip": "string",
"symbol": "string",
"description": "string",
"instrumentId": 0,
"netChange": 0,
"type": "SWEEP_VEHICLE"
},
"instruction": "BUY",
"positionEffect": "OPENING",
"quantity": 0,
"quantityType": "ALL_SHARES",
"divCapGains": "REINVEST",
"toSymbol": "string"
}
],
"activationPrice": 0,
"specialInstruction": "ALL_OR_NONE",
"orderStrategyType": "SINGLE",
"orderId": 0,
"cancelable": false,
"editable": false,
"status": "AWAITING_PARENT_ORDER",
"enteredTime": "2025-09-18T12:38:10.341Z",
"closeTime": "2025-09-18T12:38:10.341Z",
"tag": "string",
"accountNumber": 0,
"orderActivityCollection": [
{
"activityType": "EXECUTION",
"executionType": "FILL",
"quantity": 0,
"orderRemainingQuantity": 0,
"executionLegs": [
{
"legId": 0,
"price": 0,
"quantity": 0,
"mismarkedQuantity": 0,
"instrumentId": 0,
"time": "2025-09-18T12:38:10.341Z"
}
]
}
],
"replacingOrderCollection": [
"string"
],
"childOrderStrategies": [
"string"
],
"statusDescription": "string"
}
]
Headers:
Name	Description	Type
Schwab-Client-CorrelId
Correlation Id. Auto generated

string
No links
400
An error message indicating the validation problem with the request.

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
401
An error message indicating either authorization token is invalid or there are no accounts the caller is allowed to view or use for trading that are registered with the provided third party application

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
403
An error message indicating the caller is forbidden from accessing this service

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
404
An error message indicating the resource is not found

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
500
An error message indicating there was an unexpected server error

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
503
An error message indicating server has a temporary problem responding

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links

POST
/accounts/{accountNumber}/previewOrder
Preview order for a specific account.

Preview an order for a specific account.

Parameters
Name	Description
accountNumber *
string
(path)
The encrypted ID of the account

accountNumber
Request body

application/json
The Order Object.

Example Value
Schema
{
"orderId": 0,
"orderStrategy": {
"accountNumber": "string",
"advancedOrderType": "NONE",
"closeTime": "2025-09-18T12:38:10.345Z",
"enteredTime": "2025-09-18T12:38:10.345Z",
"orderBalance": {
"orderValue": 0,
"projectedAvailableFund": 0,
"projectedBuyingPower": 0,
"projectedCommission": 0
},
"orderStrategyType": "SINGLE",
"orderVersion": 0,
"session": "NORMAL",
"status": "AWAITING_PARENT_ORDER",
"allOrNone": true,
"discretionary": true,
"duration": "DAY",
"filledQuantity": 0,
"orderType": "MARKET",
"orderValue": 0,
"price": 0,
"quantity": 0,
"remainingQuantity": 0,
"sellNonMarginableFirst": true,
"settlementInstruction": "REGULAR",
"strategy": "NONE",
"amountIndicator": "DOLLARS",
"orderLegs": [
{
"askPrice": 0,
"bidPrice": 0,
"lastPrice": 0,
"markPrice": 0,
"projectedCommission": 0,
"quantity": 0,
"finalSymbol": "string",
"legId": 0,
"assetType": "EQUITY",
"instruction": "BUY"
}
]
},
"orderValidationResult": {
"alerts": [
{
"validationRuleName": "string",
"message": "string",
"activityMessage": "string",
"originalSeverity": "ACCEPT",
"overrideName": "string",
"overrideSeverity": "ACCEPT"
}
],
"accepts": [
{
"validationRuleName": "string",
"message": "string",
"activityMessage": "string",
"originalSeverity": "ACCEPT",
"overrideName": "string",
"overrideSeverity": "ACCEPT"
}
],
"rejects": [
{
"validationRuleName": "string",
"message": "string",
"activityMessage": "string",
"originalSeverity": "ACCEPT",
"overrideName": "string",
"overrideSeverity": "ACCEPT"
}
],
"reviews": [
{
"validationRuleName": "string",
"message": "string",
"activityMessage": "string",
"originalSeverity": "ACCEPT",
"overrideName": "string",
"overrideSeverity": "ACCEPT"
}
],
"warns": [
{
"validationRuleName": "string",
"message": "string",
"activityMessage": "string",
"originalSeverity": "ACCEPT",
"overrideName": "string",
"overrideSeverity": "ACCEPT"
}
]
},
"commissionAndFee": {
"commission": {
"commissionLegs": [
{
"commissionValues": [
{
"value": 0,
"type": "COMMISSION"
}
]
}
]
},
"fee": {
"feeLegs": [
{
"feeValues": [
{
"value": 0,
"type": "COMMISSION"
}
]
}
]
},
"trueCommission": {
"commissionLegs": [
{
"commissionValues": [
{
"value": 0,
"type": "COMMISSION"
}
]
}
]
}
}
}
Responses
Code	Description	Links
200
An order object, matching the input parameters

Media type

application/json
Controls Accept header.
Example Value
Schema
{
"orderId": 0,
"orderStrategy": {
"accountNumber": "string",
"advancedOrderType": "NONE",
"closeTime": "2025-09-18T12:38:10.347Z",
"enteredTime": "2025-09-18T12:38:10.347Z",
"orderBalance": {
"orderValue": 0,
"projectedAvailableFund": 0,
"projectedBuyingPower": 0,
"projectedCommission": 0
},
"orderStrategyType": "SINGLE",
"orderVersion": 0,
"session": "NORMAL",
"status": "AWAITING_PARENT_ORDER",
"allOrNone": true,
"discretionary": true,
"duration": "DAY",
"filledQuantity": 0,
"orderType": "MARKET",
"orderValue": 0,
"price": 0,
"quantity": 0,
"remainingQuantity": 0,
"sellNonMarginableFirst": true,
"settlementInstruction": "REGULAR",
"strategy": "NONE",
"amountIndicator": "DOLLARS",
"orderLegs": [
{
"askPrice": 0,
"bidPrice": 0,
"lastPrice": 0,
"markPrice": 0,
"projectedCommission": 0,
"quantity": 0,
"finalSymbol": "string",
"legId": 0,
"assetType": "EQUITY",
"instruction": "BUY"
}
]
},
"orderValidationResult": {
"alerts": [
{
"validationRuleName": "string",
"message": "string",
"activityMessage": "string",
"originalSeverity": "ACCEPT",
"overrideName": "string",
"overrideSeverity": "ACCEPT"
}
],
"accepts": [
{
"validationRuleName": "string",
"message": "string",
"activityMessage": "string",
"originalSeverity": "ACCEPT",
"overrideName": "string",
"overrideSeverity": "ACCEPT"
}
],
"rejects": [
{
"validationRuleName": "string",
"message": "string",
"activityMessage": "string",
"originalSeverity": "ACCEPT",
"overrideName": "string",
"overrideSeverity": "ACCEPT"
}
],
"reviews": [
{
"validationRuleName": "string",
"message": "string",
"activityMessage": "string",
"originalSeverity": "ACCEPT",
"overrideName": "string",
"overrideSeverity": "ACCEPT"
}
],
"warns": [
{
"validationRuleName": "string",
"message": "string",
"activityMessage": "string",
"originalSeverity": "ACCEPT",
"overrideName": "string",
"overrideSeverity": "ACCEPT"
}
]
},
"commissionAndFee": {
"commission": {
"commissionLegs": [
{
"commissionValues": [
{
"value": 0,
"type": "COMMISSION"
}
]
}
]
},
"fee": {
"feeLegs": [
{
"feeValues": [
{
"value": 0,
"type": "COMMISSION"
}
]
}
]
},
"trueCommission": {
"commissionLegs": [
{
"commissionValues": [
{
"value": 0,
"type": "COMMISSION"
}
]
}
]
}
}
}
Headers:
Name	Description	Type
Schwab-Client-CorrelId
Correlation Id. Auto generated

string
No links
400
An error message indicating the validation problem with the request.

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
401
An error message indicating either authorization token is invalid or there are no accounts the caller is allowed to view or use for trading that are registered with the provided third party application

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
403
An error message indicating the caller is forbidden from accessing this service

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
404
An error message indicating the resource is not found

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
500
An error message indicating there was an unexpected server error

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
503
An error message indicating server has a temporary problem responding

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
Transactions


GET
/accounts/{accountNumber}/transactions
Get all transactions information for a specific account.

All transactions for a specific account. Maximum number of transactions in response is 3000. Maximum date range is 1 year.

Parameters
Name	Description
accountNumber *
string
(path)
The encrypted ID of the account

accountNumber
startDate *
string
(query)
Specifies that no transactions entered before this time should be returned. Valid ISO-8601 formats are :
yyyy-MM-dd'T'HH:mm:ss.SSSZ . Example start date is '2024-03-28T21:10:42.000Z'. The 'endDate' must also be set.

startDate
endDate *
string
(query)
Specifies that no transactions entered after this time should be returned.Valid ISO-8601 formats are :
yyyy-MM-dd'T'HH:mm:ss.SSSZ. Example start date is '2024-05-10T21:10:42.000Z'. The 'startDate' must also be set.

endDate
symbol
string
(query)
It filters all the transaction activities based on the symbol specified. NOTE: If there is any special character in the symbol, please send th encoded value.

symbol
types *
string
(query)
Specifies that only transactions of this status should be returned.

Available values : TRADE, RECEIVE_AND_DELIVER, DIVIDEND_OR_INTEREST, ACH_RECEIPT, ACH_DISBURSEMENT, CASH_RECEIPT, CASH_DISBURSEMENT, ELECTRONIC_FUND, WIRE_OUT, WIRE_IN, JOURNAL, MEMORANDUM, MARGIN_CALL, MONEY_MARKET, SMA_ADJUSTMENT


TRADE
Responses
Code	Description	Links
200
A List of orders for the account, matching the provided input parameters

Media type

application/json
Controls Accept header.
Example Value
Schema
[
{
"activityId": 0,
"time": "2025-09-18T12:38:10.354Z",
"user": {
"cdDomainId": "string",
"login": "string",
"type": "ADVISOR_USER",
"userId": 0,
"systemUserName": "string",
"firstName": "string",
"lastName": "string",
"brokerRepCode": "string"
},
"description": "string",
"accountNumber": "string",
"type": "TRADE",
"status": "VALID",
"subAccount": "CASH",
"tradeDate": "2025-09-18T12:38:10.354Z",
"settlementDate": "2025-09-18T12:38:10.354Z",
"positionId": 0,
"orderId": 0,
"netAmount": 0,
"activityType": "ACTIVITY_CORRECTION",
"transferItems": [
{
"instrument": {
"cusip": "string",
"symbol": "string",
"description": "string",
"instrumentId": 0,
"netChange": 0,
"type": "SWEEP_VEHICLE"
},
"amount": 0,
"cost": 0,
"price": 0,
"feeType": "COMMISSION",
"positionEffect": "OPENING"
}
]
}
]
Headers:
Name	Description	Type
Schwab-Client-CorrelId
Correlation Id. Auto generated

string
No links
400
An error message indicating the validation problem with the request.

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
401
An error message indicating either authorization token is invalid or there are no accounts the caller is allowed to view or use for trading that are registered with the provided third party application

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
403
An error message indicating the caller is forbidden from accessing this service

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
404
An error message indicating the resource is not found

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
500
An error message indicating there was an unexpected server error

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
503
An error message indicating server has a temporary problem responding

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links

GET
/accounts/{accountNumber}/transactions/{transactionId}
Get specific transaction information for a specific account

Get specific transaction information for a specific account

Parameters
Name	Description
accountNumber *
string
(path)
The encrypted ID of the account

accountNumber
transactionId *
integer($int64)
(path)
The ID of the transaction being retrieved.

transactionId
Responses
Code	Description	Links
200
A List of orders for the account, matching the provided input parameters

Media type

application/json
Controls Accept header.
Example Value
Schema
[
{
"activityId": 0,
"time": "2025-09-18T12:38:10.358Z",
"user": {
"cdDomainId": "string",
"login": "string",
"type": "ADVISOR_USER",
"userId": 0,
"systemUserName": "string",
"firstName": "string",
"lastName": "string",
"brokerRepCode": "string"
},
"description": "string",
"accountNumber": "string",
"type": "TRADE",
"status": "VALID",
"subAccount": "CASH",
"tradeDate": "2025-09-18T12:38:10.358Z",
"settlementDate": "2025-09-18T12:38:10.358Z",
"positionId": 0,
"orderId": 0,
"netAmount": 0,
"activityType": "ACTIVITY_CORRECTION",
"transferItems": [
{
"instrument": {
"cusip": "string",
"symbol": "string",
"description": "string",
"instrumentId": 0,
"netChange": 0,
"type": "SWEEP_VEHICLE"
},
"amount": 0,
"cost": 0,
"price": 0,
"feeType": "COMMISSION",
"positionEffect": "OPENING"
}
]
}
]
Headers:
Name	Description	Type
Schwab-Client-CorrelId
Correlation Id. Auto generated

string
No links
400
An error message indicating the validation problem with the request.

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
401
An error message indicating either authorization token is invalid or there are no accounts the caller is allowed to view or use for trading that are registered with the provided third party application

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
403
An error message indicating the caller is forbidden from accessing this service

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
404
An error message indicating the resource is not found

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
500
An error message indicating there was an unexpected server error

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
503
An error message indicating server has a temporary problem responding

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
UserPreference


GET
/userPreference
Get user preference information for the logged in user.

Get user preference information for the logged in user.

Parameters
No parameters

Responses
Code	Description	Links
200
List of user preference values.

Media type

application/json
Controls Accept header.
Example Value
Schema
[
{
"accounts": [
{
"accountNumber": "string",
"primaryAccount": false,
"type": "string",
"nickName": "string",
"accountColor": "string",
"displayAcctId": "string",
"autoPositionEffect": false
}
],
"streamerInfo": [
{
"streamerSocketUrl": "string",
"schwabClientCustomerId": "string",
"schwabClientCorrelId": "string",
"schwabClientChannel": "string",
"schwabClientFunctionId": "string"
}
],
"offers": [
{
"level2Permissions": false,
"mktDataPermission": "string"
}
]
}
]
No links
400
An error message indicating the validation problem with the request.

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
401
An error message indicating either authorization token is invalid or there are no accounts the caller is allowed to view or use for trading that are registered with the provided third party application

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
403
An error message indicating the caller is forbidden from accessing this service

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
404
An error message indicating the resource is not found

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
500
An error message indicating there was an unexpected server error

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links
503
An error message indicating server has a temporary problem responding

Media type

application/json
Example Value
Schema
{
"message": "string",
"errors": [
"string"
]
}
Headers:
Name	Description	Type
Schwab-Client-CorrelID
Correlation Id. Auto generated

string
No links

Schemas
AccountNumberHash{
accountNumber	[...]
hashValue	[...]
}
sessionstring
Enum:
Array [ 4 ]
durationstring
Enum:
Array [ 8 ]
orderTypestring
Enum:
Array [ 15 ]
orderTypeRequeststring
Same as orderType, but does not have UNKNOWN since this type is not allowed as an input

Enum:
Array [ 14 ]
complexOrderStrategyTypestring
Enum:
Array [ 21 ]
requestedDestinationstring
Enum:
Array [ 12 ]
stopPriceLinkBasisstring
Enum:
Array [ 9 ]
stopPriceLinkTypestring
Enum:
Array [ 3 ]
stopPriceOffsetnumber($double)
stopTypestring
Enum:
Array [ 5 ]
priceLinkBasisstring
Enum:
Array [ 9 ]
priceLinkTypestring
Enum:
Array [ 3 ]
taxLotMethodstring
Enum:
Array [ 7 ]
specialInstructionstring
Enum:
Array [ 3 ]
orderStrategyTypestring
Enum:
Array [ 9 ]
statusstring
Enum:
Array [ 21 ]
amountIndicatorstring
Enum:
Array [ 5 ]
settlementInstructionstring
Enum:
Array [ 4 ]
OrderStrategy{
accountNumber	[...]
advancedOrderType	[...]
closeTime	[...]
enteredTime	[...]
orderBalance	OrderBalance{...}
orderStrategyType	orderStrategyType[...]
orderVersion	[...]
session	session[...]
status	apiOrderStatus[...]
allOrNone	[...]
discretionary	[...]
duration	duration[...]
filledQuantity	[...]
orderType	orderType[...]
orderValue	[...]
price	[...]
quantity	[...]
remainingQuantity	[...]
sellNonMarginableFirst	[...]
settlementInstruction	settlementInstruction[...]
strategy	complexOrderStrategyType[...]
amountIndicator	amountIndicator[...]
orderLegs	[...]
}
OrderLeg{
askPrice	[...]
bidPrice	[...]
lastPrice	[...]
markPrice	[...]
projectedCommission	[...]
quantity	[...]
finalSymbol	[...]
legId	[...]
assetType	assetType[...]
instruction	instruction[...]
}
OrderBalance{
orderValue	[...]
projectedAvailableFund	[...]
projectedBuyingPower	[...]
projectedCommission	[...]
}
OrderValidationResult{
alerts	[...]
accepts	[...]
rejects	[...]
reviews	[...]
warns	[...]
}
OrderValidationDetail{
validationRuleName	[...]
message	[...]
activityMessage	[...]
originalSeverity	APIRuleAction[...]
overrideName	[...]
overrideSeverity	APIRuleAction[...]
}
APIRuleActionstring
Enum:
Array [ 5 ]
CommissionAndFee{
commission	Commission{...}
fee	Fees{...}
trueCommission	Commission{...}
}
Commission{
commissionLegs	[...]
}
CommissionLeg{
commissionValues	[...]
}
CommissionValue{
value	[...]
type	FeeType[...]
}
Fees{
feeLegs	[...]
}
FeeLeg{
feeValues	[...]
}
FeeValue{
value	[...]
type	FeeType[...]
}
FeeTypestring
Enum:
Array [ 25 ]
Account{
securitiesAccount	SecuritiesAccount{...}
}
DateParam{
date	[...]
}
Order{
session	session[...]
duration	duration[...]
orderType	orderType[...]
cancelTime	[...]
complexOrderStrategyType	complexOrderStrategyType[...]
quantity	[...]
filledQuantity	[...]
remainingQuantity	[...]
requestedDestination	requestedDestination[...]
destinationLinkName	[...]
releaseTime	[...]
stopPrice	[...]
stopPriceLinkBasis	stopPriceLinkBasis[...]
stopPriceLinkType	stopPriceLinkType[...]
stopPriceOffset	[...]
stopType	stopType[...]
priceLinkBasis	priceLinkBasis[...]
priceLinkType	priceLinkType[...]
price	[...]
taxLotMethod	taxLotMethod[...]
orderLegCollection	[...]
activationPrice	[...]
specialInstruction	specialInstruction[...]
orderStrategyType	orderStrategyType[...]
orderId	[...]
cancelable	[...]
editable	[...]
status	status[...]
enteredTime	[...]
closeTime	[...]
tag	[...]
accountNumber	[...]
orderActivityCollection	[...]
replacingOrderCollection	[...]
childOrderStrategies	[...]
statusDescription	[...]
}
OrderRequest{
session	session[...]
duration	duration[...]
orderType	orderTypeRequest[...]
cancelTime	[...]
complexOrderStrategyType	complexOrderStrategyType[...]
quantity	[...]
filledQuantity	[...]
remainingQuantity	[...]
destinationLinkName	[...]
releaseTime	[...]
stopPrice	[...]
stopPriceLinkBasis	stopPriceLinkBasis[...]
stopPriceLinkType	stopPriceLinkType[...]
stopPriceOffset	[...]
stopType	stopType[...]
priceLinkBasis	priceLinkBasis[...]
priceLinkType	priceLinkType[...]
price	[...]
taxLotMethod	taxLotMethod[...]
orderLegCollection	[...]
activationPrice	[...]
specialInstruction	specialInstruction[...]
orderStrategyType	orderStrategyType[...]
orderId	[...]
cancelable	[...]
editable	[...]
status	status[...]
enteredTime	[...]
closeTime	[...]
accountNumber	[...]
orderActivityCollection	[...]
replacingOrderCollection	[...]
childOrderStrategies	[...]
statusDescription	[...]
}
PreviewOrder{
orderId	[...]
orderStrategy	OrderStrategy{...}
orderValidationResult	OrderValidationResult{...}
commissionAndFee	CommissionAndFee{...}
}
OrderActivity{
activityType	[...]
executionType	[...]
quantity	[...]
orderRemainingQuantity	[...]
executionLegs	[...]
}
ExecutionLeg{
legId	[...]
price	[...]
quantity	[...]
mismarkedQuantity	[...]
instrumentId	[...]
time	[...]
}
Position{
shortQuantity	[...]
averagePrice	[...]
currentDayProfitLoss	[...]
currentDayProfitLossPercentage	[...]
longQuantity	[...]
settledLongQuantity	[...]
settledShortQuantity	[...]
agedQuantity	[...]
instrument	AccountsInstrument{...}
marketValue	[...]
maintenanceRequirement	[...]
averageLongPrice	[...]
averageShortPrice	[...]
taxLotAverageLongPrice	[...]
taxLotAverageShortPrice	[...]
longOpenProfitLoss	[...]
shortOpenProfitLoss	[...]
previousSessionLongQuantity	[...]
previousSessionShortQuantity	[...]
currentDayCost	[...]
}
ServiceError{
message	[...]
errors	[...]
}
OrderLegCollection{
orderLegType	[...]
legId	[...]
instrument	AccountsInstrument{...}
instruction	instruction[...]
positionEffect	[...]
quantity	[...]
quantityType	[...]
divCapGains	[...]
toSymbol	[...]
}
SecuritiesAccount{
oneOf ->
MarginAccount{...}
CashAccount{...}
}
SecuritiesAccountBase{
type	[...]
accountNumber	[...]
roundTrips	[...]
isDayTrader	[...]
isClosingOnlyRestricted	[...]
pfcbFlag	[...]
positions	[...]
}
MarginAccount{
type	[...]
accountNumber	[...]
roundTrips	[...]
isDayTrader	[...]
isClosingOnlyRestricted	[...]
pfcbFlag	[...]
positions	[...]
initialBalances	MarginInitialBalance{...}
currentBalances	MarginBalance{...}
projectedBalances	MarginBalance{...}
}
MarginInitialBalance{
accruedInterest	[...]
availableFundsNonMarginableTrade	[...]
bondValue	[...]
buyingPower	[...]
cashBalance	[...]
cashAvailableForTrading	[...]
cashReceipts	[...]
dayTradingBuyingPower	[...]
dayTradingBuyingPowerCall	[...]
dayTradingEquityCall	[...]
equity	[...]
equityPercentage	[...]
liquidationValue	[...]
longMarginValue	[...]
longOptionMarketValue	[...]
longStockValue	[...]
maintenanceCall	[...]
maintenanceRequirement	[...]
margin	[...]
marginEquity	[...]
moneyMarketFund	[...]
mutualFundValue	[...]
regTCall	[...]
shortMarginValue	[...]
shortOptionMarketValue	[...]
shortStockValue	[...]
totalCash	[...]
isInCall	[...]
unsettledCash	[...]
pendingDeposits	[...]
marginBalance	[...]
shortBalance	[...]
accountValue	[...]
}
MarginBalance{
availableFunds	[...]
availableFundsNonMarginableTrade	[...]
buyingPower	[...]
buyingPowerNonMarginableTrade	[...]
dayTradingBuyingPower	[...]
dayTradingBuyingPowerCall	[...]
equity	[...]
equityPercentage	[...]
longMarginValue	[...]
maintenanceCall	[...]
maintenanceRequirement	[...]
marginBalance	[...]
regTCall	[...]
shortBalance	[...]
shortMarginValue	[...]
sma	[...]
isInCall	[...]
stockBuyingPower	[...]
optionBuyingPower	[...]
}
CashAccount{
type	[...]
accountNumber	[...]
roundTrips	[...]
isDayTrader	[...]
isClosingOnlyRestricted	[...]
pfcbFlag	[...]
positions	[...]
initialBalances	CashInitialBalance{...}
currentBalances	CashBalance{...}
projectedBalances	CashBalance{...}
}
CashInitialBalance{
accruedInterest	[...]
cashAvailableForTrading	[...]
cashAvailableForWithdrawal	[...]
cashBalance	[...]
bondValue	[...]
cashReceipts	[...]
liquidationValue	[...]
longOptionMarketValue	[...]
longStockValue	[...]
moneyMarketFund	[...]
mutualFundValue	[...]
shortOptionMarketValue	[...]
shortStockValue	[...]
isInCall	[...]
unsettledCash	[...]
cashDebitCallValue	[...]
pendingDeposits	[...]
accountValue	[...]
}
CashBalance{
cashAvailableForTrading	[...]
cashAvailableForWithdrawal	[...]
cashCall	[...]
longNonMarginableMarketValue	[...]
totalCash	[...]
cashDebitCallValue	[...]
unsettledCash	[...]
}
TransactionBaseInstrument{
assetType*	[...]
cusip	[...]
symbol	[...]
description	[...]
instrumentId	[...]
netChange	[...]
}
AccountsBaseInstrument{
assetType*	[...]
cusip	[...]
symbol	[...]
description	[...]
instrumentId	[...]
netChange	[...]
}
AccountsInstrument{
oneOf ->
AccountCashEquivalent{...}
AccountEquity{...}
AccountFixedIncome{...}
AccountMutualFund{...}
AccountOption{...}
}
TransactionInstrument{
oneOf ->
TransactionCashEquivalent{...}
CollectiveInvestment{...}
Currency{...}
TransactionEquity{...}
TransactionFixedIncome{...}
Forex{...}
Future{...}
Index{...}
TransactionMutualFund{...}
TransactionOption{...}
Product{...}
}
TransactionCashEquivalent{
assetType*	[...]
cusip	[...]
symbol	[...]
description	[...]
instrumentId	[...]
netChange	[...]
type	[...]
}
CollectiveInvestment{
assetType*	[...]
cusip	[...]
symbol	[...]
description	[...]
instrumentId	[...]
netChange	[...]
type	[...]
}
instructionstring
Enum:
Array [ 10 ]
assetTypestring
Enum:
Array [ 11 ]
Currency{
assetType*	[...]
cusip	[...]
symbol	[...]
description	[...]
instrumentId	[...]
netChange	[...]
}
TransactionEquity{
assetType*	[...]
cusip	[...]
symbol	[...]
description	[...]
instrumentId	[...]
netChange	[...]
type	[...]
}
TransactionFixedIncome{
assetType*	[...]
cusip	[...]
symbol	[...]
description	[...]
instrumentId	[...]
netChange	[...]
type	[...]
maturityDate	[...]
factor	[...]
multiplier	[...]
variableRate	[...]
}
Forex{
assetType*	[...]
cusip	[...]
symbol	[...]
description	[...]
instrumentId	[...]
netChange	[...]
type	[...]
baseCurrency	Currency{...}
counterCurrency	Currency{...}
}
Future{
activeContract	[...]
type	[...]
expirationDate	[...]
lastTradingDate	[...]
firstNoticeDate	[...]
multiplier	[...]
oneOf ->
TransactionCashEquivalent{...}
CollectiveInvestment{...}
Currency{...}
TransactionEquity{...}
TransactionFixedIncome{...}
Forex{...}
{...}
Index{...}
TransactionMutualFund{...}
TransactionOption{...}
Product{...}
}
Index{
activeContract	[...]
type	[...]
oneOf ->
TransactionCashEquivalent{...}
CollectiveInvestment{...}
Currency{...}
TransactionEquity{...}
TransactionFixedIncome{...}
Forex{...}
Future{...}
{...}
TransactionMutualFund{...}
TransactionOption{...}
Product{...}
}
TransactionMutualFund{
assetType*	[...]
cusip	[...]
symbol	[...]
description	[...]
instrumentId	[...]
netChange	[...]
fundFamilyName	[...]
fundFamilySymbol	[...]
fundGroup	[...]
type	[...]
exchangeCutoffTime	[...]
purchaseCutoffTime	[...]
redemptionCutoffTime	[...]
}
TransactionOption{
assetType*	[...]
cusip	[...]
symbol	[...]
description	[...]
instrumentId	[...]
netChange	[...]
expirationDate	[...]
optionDeliverables	[...]
optionPremiumMultiplier	[...]
putCall	[...]
strikePrice	[...]
type	[...]
underlyingSymbol	[...]
underlyingCusip	[...]
deliverable	TransactionInstrument{...}
}
Product{
assetType*	[...]
cusip	[...]
symbol	[...]
description	[...]
instrumentId	[...]
netChange	[...]
type	[...]
}
AccountCashEquivalent{
assetType*	[...]
cusip	[...]
symbol	[...]
description	[...]
instrumentId	[...]
netChange	[...]
type	[...]
}
AccountEquity{
assetType*	[...]
cusip	[...]
symbol	[...]
description	[...]
instrumentId	[...]
netChange	[...]
}
AccountFixedIncome{
assetType*	[...]
cusip	[...]
symbol	[...]
description	[...]
instrumentId	[...]
netChange	[...]
maturityDate	[...]
factor	[...]
variableRate	[...]
}
AccountMutualFund{
assetType*	[...]
cusip	[...]
symbol	[...]
description	[...]
instrumentId	[...]
netChange	[...]
}
AccountOption{
assetType*	[...]
cusip	[...]
symbol	[...]
description	[...]
instrumentId	[...]
netChange	[...]
optionDeliverables	[...]
putCall	[...]
optionMultiplier	[...]
type	[...]
underlyingSymbol	[...]
}
AccountAPIOptionDeliverable{
symbol	[...]
deliverableUnits	[...]
apiCurrencyType	[...]
assetType	assetType[...]
}
TransactionAPIOptionDeliverable{
rootSymbol	[...]
strikePercent	[...]
deliverableNumber	[...]
deliverableUnits	[...]
deliverable	TransactionInstrument{...}
assetType	assetType[...]
}
apiOrderStatusstring
Enum:
Array [ 21 ]
TransactionTypestring
Enum:
Array [ 15 ]
Transaction{
activityId	[...]
time	[...]
user	UserDetails{...}
description	[...]
accountNumber	[...]
type	TransactionType[...]
status	[...]
subAccount	[...]
tradeDate	[...]
settlementDate	[...]
positionId	[...]
orderId	[...]
netAmount	[...]
activityType	[...]
transferItems	[...]
}
UserDetails{
cdDomainId	[...]
login	[...]
type	[...]
userId	[...]
systemUserName	[...]
firstName	[...]
lastName	[...]
brokerRepCode	[...]
}
TransferItem{
instrument	TransactionInstrument{...}
amount	[...]
cost	[...]
price	[...]
feeType	[...]
positionEffect	[...]
}
UserPreference{
accounts	[...]
streamerInfo	[...]
offers	[...]
}
UserPreferenceAccount{
accountNumber	[...]
primaryAccount	[...]
type	[...]
nickName	[...]
accountColor	[...]
displayAcctId	[...]
autoPositionEffect	[...]
}
StreamerInfo{
streamerSocketUrl	[...]
schwabClientCustomerId	[...]
schwabClientCorrelId	[...]
schwabClientChannel	[...]
schwabClientFunctionId	[...]
}
Offer{
level2Permissions	[...]
mktDataPermission	[...]
}
Terms Of Use
|
Privacy Notice
© 2025 Charles Schwab & Co., Inc. All rights reserved. Member SIPC. Unauthorized access is prohibited. Usage is monitored.