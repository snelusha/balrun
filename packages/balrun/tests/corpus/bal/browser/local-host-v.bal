import ballerina/io;
import ballerina/udp;

public function main() {
    udp:ConnectClient|udp:Error loopback = new ("127.0.0.1", 19610, {localHost: "localhost"});
    io:println(loopback is udp:ConnectClient); // @output true

    udp:ConnectClient|udp:Error outside = new ("127.0.0.1", 19610, {localHost: "192.0.2.1"});
    io:println(outside is udp:Error && outside.message().includes("sockets are unavailable in this environment")); // @output true
}
