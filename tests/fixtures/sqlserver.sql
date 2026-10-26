-- Run only inside the optional disposable SQL Server fixture, never a user server.
IF DB_ID(N'kitsune_test') IS NOT NULL THROW 50001, 'Fixture database already exists; recreate the disposable container instead.', 1;
GO
CREATE DATABASE kitsune_test;
GO
USE kitsune_test;
GO
CREATE TABLE dbo.kitsune_fixture_identity(marker NVARCHAR(100) PRIMARY KEY);
INSERT INTO dbo.kitsune_fixture_identity VALUES(N'kitsune-disposable-network-v1');
CREATE TABLE dbo.customers(id BIGINT PRIMARY KEY,name NVARCHAR(200) NOT NULL,email NVARCHAR(200));
CREATE TABLE dbo.products(id BIGINT PRIMARY KEY,name NVARCHAR(200) NOT NULL,price DECIMAL(30,9));
CREATE TABLE dbo.orders(id BIGINT PRIMARY KEY,customer_id BIGINT NOT NULL REFERENCES dbo.customers(id),status NVARCHAR(50) NOT NULL DEFAULT N'pending',total DECIMAL(30,9),metadata NVARCHAR(MAX),secret_token NVARCHAR(200));
CREATE TABLE dbo.order_items(order_id BIGINT REFERENCES dbo.orders(id),line_number INT,product_id BIGINT REFERENCES dbo.products(id),quantity INT,PRIMARY KEY(order_id,line_number));
CREATE TABLE dbo.payments(id BIGINT PRIMARY KEY,order_id BIGINT REFERENCES dbo.orders(id),status NVARCHAR(50),receipt VARBINARY(MAX));
CREATE TABLE dbo.composite_parent(tenant NVARCHAR(50),code NVARCHAR(50),label NVARCHAR(200),PRIMARY KEY(tenant,code));
CREATE TABLE dbo.composite_child(id BIGINT PRIMARY KEY,tenant NVARCHAR(50),code NVARCHAR(50),FOREIGN KEY(tenant,code) REFERENCES dbo.composite_parent(tenant,code));
INSERT INTO dbo.customers VALUES(1,N'Avery Kim',N'avery@example.test');
INSERT INTO dbo.products VALUES(100,N'Field notebook',19.95);
INSERT INTO dbo.orders VALUES(5821,1,N'pending',99999999999999999.123456789,N'{"source":"fixture"}',N'fixture-secret');
INSERT INTO dbo.order_items VALUES(5821,1,100,2);
INSERT INTO dbo.payments VALUES(700,5821,N'authorized',0x00FF80);
INSERT INTO dbo.composite_parent VALUES(N'acme',N'A',N'Composite parent');
INSERT INTO dbo.composite_child VALUES(1,N'acme',N'A');
GO
CREATE VIEW dbo.pending_orders AS SELECT id,customer_id,status,total FROM dbo.orders WHERE status=N'pending';
GO
CREATE LOGIN kitsune_test WITH PASSWORD='Kitsune_fixture_rw_42!';
CREATE LOGIN kitsune_readonly WITH PASSWORD='Kitsune_fixture_ro_42!';
CREATE USER kitsune_test FOR LOGIN kitsune_test;
CREATE USER kitsune_readonly FOR LOGIN kitsune_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE, VIEW DEFINITION, SHOWPLAN TO kitsune_test;
GRANT SELECT, VIEW DEFINITION, SHOWPLAN TO kitsune_readonly;
DENY INSERT, UPDATE, DELETE, EXECUTE, ALTER, CREATE TABLE TO kitsune_readonly;
GO
