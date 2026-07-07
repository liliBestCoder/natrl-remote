-- Fix charset for Chinese aliases
SET NAMES utf8mb4;

-- Add aliases and device_type columns
ALTER TABLE ir_protocols ADD COLUMN IF NOT EXISTS aliases JSON NULL AFTER brand_name;
ALTER TABLE ir_protocols ADD COLUMN IF NOT EXISTS device_type VARCHAR(16) NOT NULL DEFAULT 'ac' AFTER aliases;
ALTER TABLE ir_protocols ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 0 AFTER device_type;

-- Update AC brands with Chinese aliases
UPDATE ir_protocols SET aliases = '["格力"]', device_type = 'ac', priority = 1 WHERE brand_code = 'gree';
UPDATE ir_protocols SET aliases = '["美的"]', device_type = 'ac', priority = 2 WHERE brand_code = 'midea';
UPDATE ir_protocols SET aliases = '["海尔"]', device_type = 'ac', priority = 3 WHERE brand_code = 'haier';
UPDATE ir_protocols SET aliases = '["TCL"]', device_type = 'ac', priority = 4 WHERE brand_code = 'tcl';
UPDATE ir_protocols SET aliases = '["科龙"]', device_type = 'ac', priority = 5 WHERE brand_code = 'kelon';
UPDATE ir_protocols SET aliases = '["松下"]', device_type = 'ac', priority = 6 WHERE brand_code = 'panasonic';
UPDATE ir_protocols SET aliases = '["Coolix"]', device_type = 'ac', priority = 7 WHERE brand_code = 'coolix';
UPDATE ir_protocols SET aliases = '["大金"]', device_type = 'ac', priority = 8 WHERE brand_code = 'daikin';
UPDATE ir_protocols SET aliases = '["三菱"]', device_type = 'ac', priority = 9 WHERE brand_code = 'mitsubishi';
UPDATE ir_protocols SET aliases = '["富士通"]', device_type = 'ac', priority = 10 WHERE brand_code = 'fujitsu';
UPDATE ir_protocols SET aliases = '["日立"]', device_type = 'ac', priority = 11 WHERE brand_code = 'hitachi';
UPDATE ir_protocols SET aliases = '["三星"]', device_type = 'ac', priority = 12 WHERE brand_code = 'samsung';
UPDATE ir_protocols SET aliases = '["开利"]', device_type = 'ac', priority = 13 WHERE brand_code = 'carrier';
UPDATE ir_protocols SET aliases = '["LG"]', device_type = 'ac', priority = 14 WHERE brand_code = 'lg';
UPDATE ir_protocols SET aliases = '["东芝"]', device_type = 'ac', priority = 15 WHERE brand_code = 'toshiba';
UPDATE ir_protocols SET aliases = '["Electra"]', device_type = 'ac', priority = 16 WHERE brand_code = 'electra';
UPDATE ir_protocols SET aliases = '["惠而浦"]', device_type = 'ac', priority = 17 WHERE brand_code = 'whirlpool';

-- Add TV brands
INSERT IGNORE INTO ir_protocols (brand_code, brand_name, aliases, device_type, protocol, carrier_freq, bit_length, priority) VALUES
('hisense',   'Hisense',   '["海信"]',         'tv', 'NEC',  38000, 32, 1),
('tcl',       'TCL',       '["TCL","王牌"]',    'tv', 'NEC',  38000, 32, 2),
('skyworth',  'Skyworth',  '["创维"]',          'tv', 'NEC',  38000, 32, 3),
('changhong', 'Changhong', '["长虹"]',          'tv', 'NEC',  38000, 32, 4),
('konka',     'Konka',     '["康佳"]',          'tv', 'NEC',  38000, 32, 5),
('xiaomi',    'Xiaomi',    '["小米"]',          'tv', 'NEC',  38000, 32, 6),
('samsung',   'Samsung',   '["三星"]',          'tv', 'NEC',  38000, 32, 7),
('lg',        'LG',        '["LG"]',            'tv', 'NEC',  38000, 32, 8),
('sony',      'Sony',      '["索尼"]',          'tv', 'SONY', 38000, 15, 9),
('philips',   'Philips',   '["飞利浦"]',        'tv', 'RC5',  36000, 12, 10),
('panasonic', 'Panasonic', '["松下"]',          'tv', 'NEC',  38000, 32, 11),
('sharp',     'Sharp',     '["夏普"]',          'tv', 'NEC',  38000, 32, 12);
