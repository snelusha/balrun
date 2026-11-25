import ballerina/http;
import ballerina/io;

service / on new http:Listener(6969) {
    resource function get read() returns string|error {
        stream<io:Block, io:Error?> _ = check io:fileReadBlocksAsStream("late.bin", 8);
        return "opened";
    }
}
