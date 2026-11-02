import ballerina/io;
import ballerina/udp;

public function main() returns error? {
    udp:Client c = check new ({timeout: 0.1});
    readonly & udp:Datagram|udp:Error received = c->receiveDatagram();
    io:println(received is udp:Error ? received.message() : "received"); // @output Read timed out
    check c->close();
}
