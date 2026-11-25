import ballerina/io;

public function main() returns error? {
    check io:fileWriteBytes("b.bin", [0xff, 0xfe, 0x00, 0x80]);
    io:println(check io:fileReadBytes("b.bin"));
}
