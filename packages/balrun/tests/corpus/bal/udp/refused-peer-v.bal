import ballerina/io;
import ballerina/udp;

public function main() returns error? {
    udp:ConnectClient cc = check new ("127.0.0.1", 19603, {timeout: 2});
    check cc->writeBytes("x".toBytes());
    readonly & byte[]|udp:Error received = cc->readBytes();
    io:println(received is udp:Error && received.message().includes("connection refused")); // @output true
    check cc->close();
}
