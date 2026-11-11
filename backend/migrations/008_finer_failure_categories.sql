-- Finer failure categories (Phase 6). New checks get them from check-endpoint.ts / http-client.ts;
-- this re-labels the OLD history with the same rules, so charts and reports don't mix old and new names.

-- "network" errors that were really the server hanging up mid-request.
UPDATE check_results SET error_type = 'connection_reset'
 WHERE error_type = 'network' AND error_message LIKE '%ECONNRESET%';
UPDATE incidents SET error_type = 'connection_reset'
 WHERE error_type = 'network' AND error_message LIKE '%ECONNRESET%';

-- "unexpected_status" split by the status number: 3xx redirect, 4xx client error, 5xx server error.
UPDATE check_results SET error_type = CASE
    WHEN status_code BETWEEN 300 AND 399 THEN 'redirect'
    WHEN status_code BETWEEN 400 AND 499 THEN 'client_error'
    WHEN status_code BETWEEN 500 AND 599 THEN 'server_error'
    ELSE error_type
  END
 WHERE error_type = 'unexpected_status';

-- Incidents don't store the status code, but their message does: "Expected status 200, got 307".
-- substring(... from 'got (\d)\d\d') = the first digit of that status code.
UPDATE incidents SET error_type = CASE substring(error_message from 'got (\d)\d\d')
    WHEN '3' THEN 'redirect'
    WHEN '4' THEN 'client_error'
    WHEN '5' THEN 'server_error'
    ELSE error_type
  END
 WHERE error_type = 'unexpected_status';
