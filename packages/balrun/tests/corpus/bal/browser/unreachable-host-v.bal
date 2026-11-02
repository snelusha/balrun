import ballerina/io;
import ballerina/udp;

public function main() {
    udp:ConnectClient|udp:Error cc = new ("example.com", 19609, {});
    io:println(cc is udp:Error && cc.message().includes("sockets are unavailable in this environment")); // @output true
}
